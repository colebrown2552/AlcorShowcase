"""The pretend browser for the demo: a page model, a worker, and Chrome's side of native messaging.

Nothing here is the real extension. ``FakeBrowser`` stands in for ``extension/agents.js`` and
``extension/page.js``: it receives the same ``{op, args}`` commands, answers in the same result
shapes, and keeps a tiny page model so the demo can show a snapshot, typing, and the password
floor. The floor itself lives in the extension (JavaScript); the single rule is re-implemented in
``FakeBrowser.op_type`` so the broker-side flow (a refusal travels back, is an MCP error, and is
receipted) can be shown without a browser.

``FakeChrome`` stands in for Chrome: it starts the real ``runtime/native_host.py`` as a child
process and speaks Chrome's framing to it (4-byte little-endian length, then JSON), exactly as
Chrome would. So the attach path under test is the real one: fake worker -> real native host ->
real broker.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import struct
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO

#: Returned by an op that deliberately never answers (the demo's "hung page").
NO_ANSWER = object()


@dataclass
class Element:
    """One interactive element of the fake page."""

    role: str
    name: str
    editable: bool = False
    password: bool = False
    value: str = ""
    href: str = ""


@dataclass
class Page:
    """A fake tab: its address, title, elements and visible text."""

    url: str
    title: str
    elements: list[Element] = field(default_factory=list)
    text: str = ""
    snapshot_id: str = ""


def login_page(url: str) -> Page:
    """The demo's login form: an email box, a password box, a button and a file input."""
    return Page(
        url=url,
        title="Sign in",
        elements=[
            Element("link", "Home", href="/"),
            Element("textbox", "Email", editable=True),
            Element("textbox", "Password", editable=True, password=True),
            Element("button", "Sign in"),
        ],
        text="Sign in to continue. This is a fake page used by the demo.",
    )


class FakeBrowser:
    """A page model that executes the extension's operations.

    Args:
        extension_id: The id the fake extension claims when it fetches an upload ticket.
    """

    def __init__(self, extension_id: str) -> None:
        self.extension_id = extension_id
        self.pages: dict[int, Page] = {}
        self.next_tab_id = 101
        self.uploaded: list[dict] = []

    def execute(self, op: str, args: dict) -> dict | object:
        """Run one command. Returns a result dict, or ``NO_ANSWER`` for a page that hangs."""
        handler = getattr(self, f"op_{op}", None)
        if handler is None:
            return {"ok": False, "error": f"unknown-op {op}"}
        return handler(args)

    def _tab(self, args: dict) -> Page | None:
        return self.pages.get(args.get("tab_id", -1))

    def op_open(self, args: dict) -> dict | object:
        """Open a tab. The address ``/slow`` never answers, like a page that froze mid-load."""
        url = str(args["url"])
        if url.endswith("/slow"):
            return NO_ANSWER
        tab_id = self.next_tab_id
        self.next_tab_id += 1
        page = login_page(url) if url.endswith("/login") else Page(url, "Example", text="Hello.")
        self.pages[tab_id] = page
        return {
            "ok": True,
            "tab_id": tab_id,
            "window_id": 1,
            "active": False,
            "url": page.url,
            "title": page.title,
        }

    def op_tabs(self, _args: dict) -> dict:
        """List every fake tab."""
        rows = [
            {"tab_id": tid, "window_id": 1, "active": False, "url": p.url, "title": p.title}
            for tid, p in self.pages.items()
        ]
        return {"ok": True, "tabs": rows}

    def op_snapshot(self, args: dict) -> dict:
        """One line per element in the same format as page.js, plus the page text."""
        page = self._tab(args)
        if page is None:
            return {"ok": False, "error": "tab-gone"}
        page.snapshot_id = secrets.token_hex(4)
        lines = []
        for i, el in enumerate(page.elements, 1):
            line = f'e{i} {el.role} "{el.name}"'
            if el.password:
                line += " password"  # the value of a password field is never shown
            elif el.value:
                line += " =" + json.dumps(el.value)
            if el.editable:
                line += " editable"
            if el.href:
                line += f" -> {el.href}"
            lines.append(line)
        lines.append('f1 file-input accept="*"')
        return {
            "ok": True,
            "snapshot_id": page.snapshot_id,
            "url": page.url,
            "title": page.title,
            "elements": "\n".join(lines),
            "text": page.text,
        }

    def _element(self, page: Page, args: dict) -> Element | dict:
        if args.get("snapshot_id") != page.snapshot_id:
            return {"ok": False, "error": "stale-snapshot: take a new browser_snapshot"}
        ref = str(args.get("ref") or "")
        index = int(ref[1:]) - 1 if ref[:1] == "e" and ref[1:].isdigit() else -1
        if not 0 <= index < len(page.elements):
            return {"ok": False, "error": "stale-element: take a new browser_snapshot"}
        return page.elements[index]

    def op_type(self, args: dict) -> dict:
        """Type into a field, refusing password fields exactly as the real worker does."""
        page = self._tab(args)
        if page is None:
            return {"ok": False, "error": "tab-gone"}
        el = self._element(page, args)
        if isinstance(el, dict):
            return el
        if el.password:
            return {
                "ok": False,
                "refused": "password-field",
                "hint": "the operator types passwords",
            }
        if not el.editable:
            return {"ok": False, "error": "not-editable"}
        el.value = ("" if args.get("clear", True) else el.value) + str(args["text"])
        return {"ok": True, "via": "cdp", "value": el.value}

    def op_click(self, args: dict) -> dict:
        """Click an element and report it, as the real worker's locate + trusted click does."""
        page = self._tab(args)
        if page is None:
            return {"ok": False, "error": "tab-gone"}
        el = self._element(page, args)
        if isinstance(el, dict):
            return el
        return {
            "ok": True,
            "clicked": f'{el.role} "{el.name}"',
            "via": "cdp",
            "url": page.url,
            "title": page.title,
        }

    def op_upload(self, args: dict) -> dict:
        """Fetch the one-time ticket like the real worker, check the bytes, keep the metadata."""
        request = urllib.request.Request(
            str(args["ticket_url"]), headers={"Origin": f"chrome-extension://{self.extension_id}"}
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                data = response.read()
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": f"upload-ticket-{exc.code}"}
        if len(data) != args["size"]:
            return {"ok": False, "error": "upload-bytes-mismatch"}
        self.uploaded.append({"name": args["name"], "size": len(data), "mime": args["mime"]})
        digest = hashlib.sha256(data).hexdigest()[:12]
        return {"ok": True, "method": "input", "received_sha256": digest}

    def op_reload(self, _args: dict) -> dict:
        """Pretend to reload the extension (the real worker calls ``chrome.runtime.reload``)."""
        return {"ok": True, "reloading": True}

    def op_close(self, args: dict) -> dict:
        """Close a fake tab."""
        self.pages.pop(args.get("tab_id", -1), None)
        return {"ok": True}


def _write_frame(stream: BinaryIO, message: dict) -> None:
    data = json.dumps(message).encode("utf-8")
    stream.write(struct.pack("<I", len(data)) + data)
    stream.flush()


def _read_frame(stream: BinaryIO) -> dict | None:
    head = stream.read(4)
    if len(head) < 4:
        return None
    return json.loads(stream.read(struct.unpack("<I", head)[0]).decode("utf-8"))


class FakeChrome:
    """Chrome's side of native messaging, running a ``FakeBrowser`` as the extension worker.

    Args:
        host_script: Path of the real ``native_host.py``.
        env: Environment for the host (broker home and port).
        browser: The page model that answers commands.
        hello: The worker's first message, as ``agents.js`` would build it from ``config.js``.

    Attributes:
        commands: Every command the worker received, in order.
        welcome: The broker's ``welcome`` message once it arrives.
    """

    def __init__(self, host_script: Path, env: dict, browser: FakeBrowser, hello: dict) -> None:
        self.browser = browser
        self.commands: list[dict] = []
        self.welcome: dict | None = None
        self._welcomed = threading.Event()
        self._hub_waiters: dict[str, tuple[threading.Event, list]] = {}
        self._send_lock = threading.Lock()
        self.proc = subprocess.Popen(
            [sys.executable, "-B", str(host_script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        _write_frame(self.proc.stdin, hello)
        threading.Thread(target=self._pump, daemon=True).start()

    def wait_for_welcome(self, timeout: float = 20.0) -> dict | None:
        """Block until the broker has accepted the attach; None if it never does."""
        return self.welcome if self._welcomed.wait(timeout) else None

    def send(self, message: dict) -> None:
        """Send one message to the broker through the host."""
        with self._send_lock:
            _write_frame(self.proc.stdin, message)

    def hub(self, req: str, timeout: float = 5.0) -> dict:
        """Ask the broker what the popup asks (``status``, ``update``, ``restart``)."""
        rid = secrets.token_hex(4)
        event, box = threading.Event(), []
        self._hub_waiters[rid] = (event, box)
        self.send({"type": "hub", "id": rid, "req": req})
        event.wait(timeout)
        return box[0] if box else {}

    def close(self) -> None:
        """Close Chrome's end of the pipe, which ends the host."""
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()

    def _pump(self) -> None:
        while True:
            try:
                message = _read_frame(self.proc.stdout)
            except (OSError, ValueError):
                return
            if message is None:
                return
            kind = message.get("type")
            if kind == "welcome":
                self.welcome = message
                self._welcomed.set()
            elif kind == "hub_reply":
                event, box = self._hub_waiters.pop(message.get("id"), (None, None))
                if event:
                    box.append(message.get("value") or {})
                    event.set()
            elif kind == "command":
                self.commands.append(message)
                result = self.browser.execute(message["op"], message.get("args") or {})
                if result is not NO_ANSWER:
                    self.send({"type": "result", "id": message["id"], "result": result})
