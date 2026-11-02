"""Native-messaging relay: Chrome's stdio on one side, the broker's attach stream on the other.

Chrome starts this program when the extension calls ``chrome.runtime.connectNative``, and only for
the extension id listed in the host manifest's ``allowed_origins``. That is the whole
authentication of the browser side: the extension holds no token. This relay reads the extension
token from the broker's state folder (readable by this user only) and presents it to
``POST /v1/ext/attach``. It also starts the broker when none is running, so nothing has to be
registered at login.

Framing on the Chrome side: a 4-byte little-endian length, then UTF-8 JSON. A message to Chrome may
not exceed 1 MiB, so only commands travel that way; results (screenshots included) travel the other
way, where Chrome allows 64 MiB. On the broker side the same messages are newline-delimited JSON.
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import struct
import sys
import threading
from typing import BinaryIO

import companion
from broker import token_file

MAX_TO_CHROME = 1024 * 1024
MAX_FROM_CHROME = 64 * 1024 * 1024


def read_native(stream: BinaryIO) -> dict | None:
    """Read one framed message from Chrome.

    Returns:
        The message, ``{}`` for a frame that is not a JSON object (skipped by the caller), or None
        when Chrome closed the pipe or sent an impossible length.
    """
    head = stream.read(4)
    if len(head) < 4:
        return None
    size = struct.unpack("<I", head)[0]
    if size > MAX_FROM_CHROME:
        return None
    body = stream.read(size)
    if len(body) < size:
        return None
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def write_native(stream: BinaryIO, lock: threading.Lock, value: dict) -> None:
    """Write one framed message to Chrome; an oversized one is replaced by an error message."""
    data = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_TO_CHROME:
        data = json.dumps({"type": "error", "error": "message-too-large-for-chrome"}).encode(
            "utf-8"
        )
    with lock:
        stream.write(struct.pack("<I", len(data)) + data)
        stream.flush()


def open_stream(host: str, port: int, token: str, hello: dict) -> socket.socket:
    """Open the broker's attach stream and return the connected socket.

    The hello is the request body; after the broker answers 200 the socket carries
    newline-delimited JSON in both directions.

    Raises:
        OSError: If the broker is unreachable or refuses the attach.
    """
    body = json.dumps(hello).encode("utf-8")
    sock = socket.create_connection((host, port), timeout=10)
    sock.sendall(
        b"POST /v1/ext/attach HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
        + f"X-Alcor-Ext-Token: {token}\r\nContent-Length: {len(body)}\r\n\r\n".encode("ascii")
        + body
    )
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(1)
        if not chunk:
            raise OSError("broker-closed-during-attach")
        head += chunk
        if len(head) > 8192:
            raise OSError("broker-header-too-large")
    status = head.split(b"\r\n", 1)[0].decode("ascii", "replace")
    if " 200 " not in status + " ":
        raise OSError(f"broker-refused-attach: {status[:80]}")
    sock.settimeout(None)
    return sock


def attach(hello: dict) -> socket.socket:
    """Start the broker if it is down, then open its attach stream for this browser."""
    if companion.start() != 0:
        raise OSError("broker-did-not-start")
    token = token_file(companion.base_dir(), "extension")
    return open_stream(companion.HOST, companion.port(), token, hello)


def main() -> int:
    """Relay between Chrome and the broker until either side closes. Returns the exit code."""
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    out_lock = threading.Lock()
    hello = read_native(stdin)
    if not hello or hello.get("type") != "hello":
        return 2
    try:
        sock = attach(hello)
    except OSError as exc:
        # Chrome shows nothing for a host that exits silently; the worker records this in its diary.
        write_native(stdout, out_lock, {"type": "error", "error": str(exc)[:200]})
        return 3
    reader = sock.makefile("rb")

    def to_chrome() -> None:
        try:
            for line in reader:
                try:
                    msg = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    continue
                write_native(stdout, out_lock, msg)
        except OSError:
            pass
        finally:
            os._exit(0)  # broker gone: exit so Chrome sees the port close and the worker reconnects

    threading.Thread(target=to_chrome, daemon=True).start()
    try:
        while True:
            msg = read_native(stdin)
            if msg is None:
                break  # Chrome closed the port
            if msg:
                sock.sendall(
                    (json.dumps(msg, ensure_ascii=True, separators=(",", ":")) + "\n").encode(
                        "utf-8"
                    )
                )
    except OSError:
        pass
    finally:
        with contextlib.suppress(OSError):
            sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
