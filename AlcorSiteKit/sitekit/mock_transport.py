"""Offline stand-in for a deploy host: a directory, a protected data file and a loopback web server.

``demo/run_demo.py`` uses two of these as "staging" and "production". A ``MockHost`` is laid out as
``deploy.py`` describes and is fronted by a web server that listens on 127.0.0.1 only and keeps the
host contract a real web server in front of a real host must keep:

* serve ``<host>/public/`` as the site root;
* answer ``/sitekit-status.json`` from ``<host>/.releases/status.json``;
* put the commit from ``<host>/.releases/current.json`` in the ``X-Sitekit-Commit`` header.

Besides serving, the host keeps the proofs the demo prints: a sentinel file in ``data/`` that no
deploy may touch, and tree digests that show a refused promotion changed nothing.

To explore by hand: ``python -m sitekit.mock_transport <host-dir> --seed`` serves a seeded host.
"""

from __future__ import annotations

import argparse
import mimetypes
import threading
import time
import urllib.parse
from collections.abc import Sequence
from contextlib import suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .deploy import HostPaths
from .fsutil import read_json, tree_digest
from .net import COMMIT_HEADER, STATUS_PATH

# The only address this module ever binds. It is a constant, not a setting, on purpose.
LOOPBACK = "127.0.0.1"
SENTINEL = b"UNRELATED DATA MUST SURVIVE"
LEGACY_PAGE = (
    b'<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Legacy site</title>'
    b"</head>\n<body><h1>Legacy site</h1><p>The site as it was before the controller.</p>"
    b"</body></html>\n"
)


class _Server(ThreadingHTTPServer):
    """A threaded server that remembers which host directory it fronts."""

    daemon_threads = True

    def __init__(self, host_root: Path) -> None:
        super().__init__((LOOPBACK, 0), _Handler)
        self.host_root = host_root


class _Handler(BaseHTTPRequestHandler):
    """Serve the host's web root, its status document and its identity header."""

    server: _Server

    def do_GET(self) -> None:
        self._respond(send_body=True)

    def do_HEAD(self) -> None:
        self._respond(send_body=False)

    def log_message(self, format: str, *args: object) -> None:
        return None

    def _respond(self, *, send_body: bool) -> None:
        paths = HostPaths(self.server.host_root)
        url_path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        file = paths.status if url_path == STATUS_PATH else _resolve(paths.public, url_path)
        try:
            body = file.read_bytes() if file is not None and file.is_file() else None
        except OSError:
            # A file being swapped out from under the read (Windows) is a miss, not a crash.
            body = None
        content = body if body is not None else b"not found\n"
        content_type = (mimetypes.guess_type(str(file))[0] if body is not None else None) or (
            "text/plain"
        )
        if content_type.startswith("text/") or content_type == "application/json":
            content_type += "; charset=utf-8"
        self.send_response(200 if body is not None else 404)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        identity = read_json(paths.identity, {})
        commit = identity.get("commit") if isinstance(identity, dict) else None
        if commit:
            self.send_header(COMMIT_HEADER, str(commit))
        self.end_headers()
        if send_body:
            with suppress(ConnectionError):
                self.wfile.write(content)


def _resolve(public: Path, url_path: str) -> Path | None:
    """Map a URL path to a file under ``public``, or None if it would leave the web root."""
    root = public.resolve()
    candidate = (root / url_path.lstrip("/")).resolve()
    if candidate != root and not candidate.is_relative_to(root):
        return None
    if url_path.endswith("/") or candidate.is_dir():
        candidate = candidate / "index.html"
    return candidate


class MockHost:
    """A host directory plus the loopback web server in front of it."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.paths = HostPaths(root)
        self._server: _Server | None = None
        self._thread: threading.Thread | None = None

    def seed(self, legacy_page: bytes = LEGACY_PAGE) -> None:
        """Create a pre-controller site and the protected data file the deploys must not touch."""
        self.paths.public.mkdir(parents=True, exist_ok=True)
        (self.paths.public / "index.html").write_bytes(legacy_page)
        (self.root / "data").mkdir(parents=True, exist_ok=True)
        (self.root / "data" / "keep.txt").write_bytes(SENTINEL)

    def start(self) -> str:
        """Start serving on a free loopback port and return the base URL."""
        self._server = _Server(self.root)
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self._thread.start()
        return self.url

    @property
    def url(self) -> str:
        """Base URL of the running server."""
        if self._server is None:
            raise RuntimeError("the mock host has not been started")
        return f"http://{LOOPBACK}:{self._server.server_address[1]}"

    def stop(self) -> None:
        """Stop the server and wait for its thread."""
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def protected_intact(self) -> bool:
        """Return True if the protected data file is exactly as seeded."""
        try:
            return (self.root / "data" / "keep.txt").read_bytes() == SENTINEL
        except OSError:
            return False

    def public_digest(self) -> str:
        """Digest of the web root, for "this operation changed nothing" proofs."""
        return tree_digest(self.paths.public)


def main(argv: Sequence[str] | None = None) -> int:
    """Serve a host directory on loopback until interrupted."""
    parser = argparse.ArgumentParser(description="Serve a mock deploy host on loopback only.")
    parser.add_argument("host_dir", type=Path)
    parser.add_argument("--seed", action="store_true", help="create the legacy site and data file")
    args = parser.parse_args(argv)
    host = MockHost(args.host_dir)
    if args.seed:
        host.seed()
    print(f"serving {args.host_dir.name} at {host.start()} (Ctrl-C to stop)", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        host.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
