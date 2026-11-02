"""``alcorcli serve``: the gate as a small HTTP engine that other programs can call.

An app that wants the gate's routing, memory and receipts should be its client, not a second
implementation of them. One warm process also avoids paying interpreter start-up on every message.

The rule is "no unauthenticated remote endpoint, ever", and there are two ways to satisfy it:

    bind 127.0.0.1            no token needed: the caller and the engine share a machine
    bind anything else        REFUSED unless ALCOR_SERVE_TOKEN is set, and then every request
                              must carry it as ``Authorization: Bearer <token>``

The token is checked with a constant-time comparison and is never logged, echoed or put in a URL.
Putting TLS in front of a non-loopback bind is the operator's job: the token is what makes the hop
safe, and TLS is what makes it private.

This grants no effect authority. The routes ask a question, read receipts, or list programs. None of
them writes a file, runs a command or edits memory.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .ask import ask
from .config import HOME_ENV, Config
from .policy import PolicyHost
from .receipts import ReceiptLog
from .routing import Lane, probe_all

TOKEN_ENV = "ALCOR_SERVE_TOKEN"
LOOPBACK_BINDS = ("127.0.0.1", "localhost", "::1")
LOOPBACK_PEERS = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
MAX_BODY = 256 * 1024


def default_token_file() -> Path:
    """The durable home of the token: ``<state dir>/serve-token``."""
    home = os.environ.get(HOME_ENV) or Path.home() / ".alcor"
    return Path(home) / "serve-token"


def serve_token() -> str:
    """The bearer token from the environment or a file, or an empty string for none.

    A file as well as an environment variable, because the process that needs it is often started
    by a service manager, where a variable set in someone's shell is not visible. The environment
    wins when both exist so a one-off run can override without editing anything.
    """
    env = str(os.environ.get(TOKEN_ENV) or "").strip()
    if env:
        return env
    try:
        return default_token_file().read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _constant_eq(a: str, b: str) -> bool:
    """Compare without leaking the match length through timing."""
    return hmac.compare_digest(str(a), str(b))


@dataclass
class ServerContext:
    """What the handlers need: configuration, the policy host, lanes and the receipt log."""

    config: Config
    policy: PolicyHost
    lanes: dict[str, Lane]
    receipts: ReceiptLog


class Handler(BaseHTTPRequestHandler):
    """Routes requests after the loopback-or-token guard."""

    server_version = "AlcorServe/1"
    context: ServerContext

    def log_message(self, format: str, *args: Any) -> None:
        """Stay quiet; the receipts are the record."""
        return None

    def _loopback(self) -> bool:
        host = (self.client_address or ("",))[0]
        return host in LOOPBACK_PEERS

    def _json(self, code: int, payload: Any) -> None:
        blob = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _guard(self) -> bool:
        """Admit a loopback peer, or a peer with the correct bearer token. Never neither.

        The two branches are not interchangeable and the order matters. A loopback peer is
        admitted without a token. A non-loopback peer is admitted only against a configured
        token; with none configured it cannot reach here at all, because ``serve`` refuses to
        bind a routable address in that case, so this is the second of two locks.
        """
        if self._loopback():
            return True
        want = serve_token()
        if not want:
            self._json(403, {"error": "loopback only"})
            return False
        given = str(self.headers.get("Authorization") or "")
        prefix = "Bearer "
        if not given.startswith(prefix) or not _constant_eq(given[len(prefix) :].strip(), want):
            # No detail in the body: which half was wrong is exactly what a prober wants told.
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self) -> None:
        """Serve the read-only routes."""
        if not self._guard():
            return
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        ctx = self.context
        try:
            if parsed.path == "/status":
                states = probe_all(ctx.lanes, 2.0)
                self._json(
                    200,
                    {
                        "schema": "alcor.serve.status.v1",
                        "lanes": [
                            {"id": k, "up": v.up, "model": v.model, "detail": v.detail}
                            for k, v in states.items()
                        ],
                        "receipts": ctx.receipts.verify(),
                        "effect_authority": False,
                    },
                )
            elif parsed.path == "/receipts":
                count = int((query.get("n") or ["10"])[0])
                self._json(200, {"receipts": ctx.receipts.tail(min(count, 100))})
            elif parsed.path == "/programs":
                self._json(200, {"programs": ctx.policy.programs()})
            else:
                self._json(404, {"error": "no such route"})
        except Exception as exc:
            self._json(500, {"error": type(exc).__name__})

    def do_POST(self) -> None:
        """Serve ``POST /ask``."""
        if not self._guard():
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            self._json(413, {"error": "body too large"})
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._json(400, {"error": "body must be JSON"})
            return
        if urlparse(self.path).path != "/ask":
            self._json(404, {"error": "no such route"})
            return
        text = str(body.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "text is required"})
            return
        ctx = self.context
        try:
            result = ask(
                text,
                config=ctx.config,
                policy=ctx.policy,
                lanes=ctx.lanes,
                receipts=ctx.receipts,
                requested=str(body.get("lane") or "auto"),
                thread=body.get("thread") or None,
            )
            self._json(200, result)
        except Exception as exc:
            self._json(500, {"error": getattr(exc, "code", type(exc).__name__)})


class ServeRefused(RuntimeError):
    """The requested bind would publish an unauthenticated endpoint."""


def make_server(host: str, port: int, context: ServerContext) -> ThreadingHTTPServer:
    """Create the server, or refuse a non-loopback bind that has no token.

    Raises:
        ServeRefused: If ``host`` is routable and no token is configured.
    """
    loopback = host in LOOPBACK_BINDS
    if not loopback and not serve_token():
        # Refuse rather than warn: a routable bind without a token publishes an unauthenticated
        # model endpoint to every machine that can reach this one.
        raise ServeRefused(
            f"refusing to bind {host}: set {TOKEN_ENV} to expose a non-loopback address, "
            "or bind 127.0.0.1"
        )
    bound = type("BoundHandler", (Handler,), {"context": context})
    return ThreadingHTTPServer((host, port), bound)


def serve(
    context: ServerContext,
    host: str = "127.0.0.1",
    port: int = 0,
    ready: threading.Event | None = None,
) -> int:
    """Serve until interrupted. Returns 2 when the bind is refused.

    Args:
        context: Handler dependencies.
        host: Address to bind. Anything but loopback needs a token.
        port: Port to bind; 0 picks a free one, printed on stderr.
        ready: Set once the socket is listening, for tests.
    """
    try:
        httpd = make_server(host, port, context)
    except ServeRefused as exc:
        print(str(exc), file=sys.stderr)
        return 2
    loopback = host in LOOPBACK_BINDS
    if loopback and serve_token():
        print(
            f"note: {TOKEN_ENV} is set but the bind is loopback; the token is unused",
            file=sys.stderr,
        )
    print(
        f"alcorcli serve on http://{host}:{httpd.server_address[1]} "
        f"({'loopback only' if loopback else 'bearer token required'})",
        file=sys.stderr,
    )
    if ready is not None:
        ready.set()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0
