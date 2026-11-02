"""Local HTTP front door for the broker, and the small command line that runs it.

The broker (``broker.py``) holds all behaviour; this file only binds a loopback socket, hands each
request to ``Broker.route`` and answers 404 otherwise. It also knows how to find a running broker
and start one, which the native relay uses so that opening the browser is what brings AlcorBrowser
up.

Commands::

    python companion.py serve                       run the broker in this terminal
    python companion.py start                       make sure one is running (detached)
    python companion.py status                      print the operator status as JSON
    python companion.py port                        print the TCP port in use
    python companion.py mcp-headers --agent NAME    print {"Authorization": "Bearer ..."}

Environment: ``ALCOR_BROWSER_HOME`` (state and config folder), ``ALCOR_BROWSER_PORT``.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from broker import SCHEMA, Broker, token_file
from settings import ConfigError, default_home, load_settings

HOST = "127.0.0.1"
#: A neutral default, chosen to avoid well-known ports. Override it with ALCOR_BROWSER_PORT.
DEFAULT_PORT = 47800
LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})


def port() -> int:
    """Return the TCP port to use: ``ALCOR_BROWSER_PORT`` if set, else ``DEFAULT_PORT``.

    Raises:
        ConfigError: If the variable is not a valid port number.
    """
    raw = os.environ.get("ALCOR_BROWSER_PORT")
    if not raw:
        return DEFAULT_PORT
    if not raw.isdigit() or not 1 <= int(raw) <= 65535:
        raise ConfigError("ALCOR_BROWSER_PORT must be a number from 1 to 65535")
    return int(raw)


def base_dir() -> Path:
    """Return the broker home (see ``settings.default_home``)."""
    return default_home()


class Handler(BaseHTTPRequestHandler):
    """Hands every request to the broker's router; anything it does not serve is a 404."""

    server_version = "AlcorBrowser/2"

    def log_message(self, format: str, *args: object) -> None:
        """Stay silent: the access log would repeat what receipts already record, minus the care."""

    def _route(self) -> None:
        if not self.server.broker.route(self):  # type: ignore[attr-defined]
            self.send_error(404)

    do_GET = do_POST = do_DELETE = _route


class BrokerServer(ThreadingHTTPServer):
    """A threaded HTTP server on a loopback address that carries the broker its handlers use.

    One thread per request is deliberate: an attached browser holds its connection open for hours,
    and agent calls must never queue behind it.
    """

    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind a port that is already listening, so two
    # brokers could share one port, or a stray process could shadow ours. Hold the port exclusively.
    allow_reuse_address = os.name != "nt"

    def __init__(self, address: tuple[str, int], broker: Broker) -> None:
        self.broker = broker
        super().__init__(address, Handler)

    def server_bind(self) -> None:
        """Bind the socket, exclusively on Windows."""
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_server(broker: Broker, host: str = HOST, listen_port: int | None = None) -> BrokerServer:
    """Bind a server for ``broker`` and tell the broker which port it really got.

    Args:
        broker: The broker to serve.
        host: Must be a loopback address; the broker is for the local machine only.
        listen_port: Port to bind; defaults to ``port()``. Use 0 for any free port.

    Returns:
        The bound (not yet serving) server.

    Raises:
        ValueError: If ``host`` is not loopback.
        OSError: If the port is taken.
    """
    if host not in LOOPBACK:
        raise ValueError("the broker listens on loopback only")
    server = BrokerServer((host, port() if listen_port is None else listen_port), broker)
    broker.port = server.server_address[1]  # upload ticket URLs need the real port
    return server


def ready(home: Path | None = None) -> bool:
    """Say whether a broker for ``home`` answers on the configured port.

    It asks the status route with the admin token, so an unrelated program that happens to hold
    the port does not count as "ready".
    """
    request = urllib.request.Request(
        f"http://{HOST}:{port()}/v1/agents/status",
        headers={"X-Alcor-Browser-Token": token_file(home or base_dir(), "admin")},
    )
    try:
        with urllib.request.urlopen(request, timeout=1.0) as response:
            value = json.loads(response.read(16384).decode("utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(value, dict) and value.get("schema") == SCHEMA


def start() -> int:
    """Make sure a broker is running, launching a detached one if not.

    Two relays starting at once may both launch a broker; the second one fails to bind and exits,
    which is harmless because the port is held exclusively.

    Returns:
        0 when a broker is answering, 4 if none came up within eight seconds.
    """
    if ready():
        return 0
    base_dir().mkdir(parents=True, exist_ok=True)
    exe = Path(sys.executable)
    if os.name == "nt" and exe.with_name("pythonw.exe").is_file():
        exe = exe.with_name("pythonw.exe")  # no console window
    detach: dict = (
        {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    subprocess.Popen(
        [str(exe), str(Path(__file__).resolve()), "serve"],
        cwd=base_dir(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        **detach,
    )
    deadline = time.time() + 8
    while time.time() < deadline:
        if ready():
            return 0
        time.sleep(0.1)
    return 4


def serve() -> int:
    """Run the broker in this process until interrupted."""
    home = base_dir()
    home.mkdir(parents=True, exist_ok=True)
    broker = Broker(home)
    try:
        server = make_server(broker)
    except OSError as exc:
        print(f"cannot listen: {exc.strerror}", file=sys.stderr)
        return 3
    broker.start()
    print(f"AlcorBrowser broker listening on http://{HOST}:{broker.port}/mcp", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def status() -> int:
    """Print the operator status of the running broker as JSON."""
    request = urllib.request.Request(
        f"http://{HOST}:{port()}/v1/agents/status",
        headers={"X-Alcor-Browser-Token": token_file(base_dir(), "admin")},
    )
    try:
        with urllib.request.urlopen(request, timeout=3.0) as response:
            print(response.read().decode("utf-8"))
    except OSError as exc:
        print(f"no broker answering: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0


def mcp_headers(agent: str) -> int:
    """Start the broker if needed and print one agent's Authorization header as JSON.

    This deliberately writes the agent's own secret to stdout: some MCP clients can run a command
    to obtain request headers, and this is that command.
    """
    if agent not in load_settings(base_dir()).agents:
        print(f"unknown agent '{agent}'; see 'agents' in config.json", file=sys.stderr)
        return 2
    start()
    sys.stdout.write(json.dumps({"Authorization": f"Bearer {token_file(base_dir(), agent)}"}))
    return 0


def main(argv: list[str] | None = None) -> int:
    """Run the command line; returns the process exit code."""
    parser = argparse.ArgumentParser(prog="companion.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "start", "status", "port"):
        sub.add_parser(name)
    headers = sub.add_parser("mcp-headers")
    headers.add_argument("--agent", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "serve":
            return serve()
        if args.command == "start":
            return start()
        if args.command == "status":
            return status()
        if args.command == "port":
            print(port())
            return 0
        return mcp_headers(args.agent)
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
