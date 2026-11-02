"""The engine can leave loopback, and only the way that keeps the rule it was protecting.

The rule is "no unauthenticated remote endpoint". Loopback satisfies it by sharing a machine with
the engine. A non-loopback bind satisfies it only with a bearer token. Four cases, and the first is
the one that must not regress:

    loopback, no token          200   the caller shares the machine and is unchanged
    remote,   no token          403
    remote,   wrong token       401
    remote,   right token       200
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from alcorcli import serve
from alcorcli.config import Config
from alcorcli.routing import Lane


class _Peer(serve.Handler):
    """The guard with a chosen peer address, so a remote client can be tested without one."""

    def __init__(self, host: str, headers: dict) -> None:
        self.client_address = (host, 0)
        self.headers = headers
        self.code = None

    def _json(self, code, payload):  # capture instead of writing
        self.code = code


def _guard(host: str, headers: dict) -> tuple:
    peer = _Peer(host, headers)
    return serve.Handler._guard(peer), peer.code


@pytest.fixture(autouse=True)
def no_token_file(monkeypatch, tmp_path):
    monkeypatch.setattr(serve, "default_token_file", lambda: tmp_path / "absent" / "serve-token")


# -- the bind rule ------------------------------------------------------------------------------


def test_a_routable_bind_is_still_refused_without_a_token(monkeypatch, capsys):
    """The original invariant, unchanged. An unauthenticated remote endpoint is never allowed."""
    monkeypatch.delenv(serve.TOKEN_ENV, raising=False)
    assert serve.serve(None, host="0.0.0.0") == 2
    assert "ALCOR_SERVE_TOKEN" in capsys.readouterr().err


def test_the_token_is_what_makes_a_routable_bind_permissible(monkeypatch):
    monkeypatch.setenv(serve.TOKEN_ENV, "s3cret")
    assert serve.serve_token() == "s3cret"


def test_the_token_can_come_from_a_file_because_a_service_has_no_shell(monkeypatch, tmp_path):
    """The process that needs it is often started by a service manager, where an environment
    variable set in someone's shell is not visible."""
    monkeypatch.delenv(serve.TOKEN_ENV, raising=False)
    target = tmp_path / "serve-token"
    target.write_text("from-a-file\n", encoding="utf-8")
    monkeypatch.setattr(serve, "default_token_file", lambda: target)
    assert serve.serve_token() == "from-a-file"


def test_the_environment_wins_over_the_file(monkeypatch, tmp_path):
    """So a one-off run can override without editing anything."""
    target = tmp_path / "serve-token"
    target.write_text("from-a-file", encoding="utf-8")
    monkeypatch.setattr(serve, "default_token_file", lambda: target)
    monkeypatch.setenv(serve.TOKEN_ENV, "from-the-env")
    assert serve.serve_token() == "from-the-env"


def test_a_missing_token_is_empty_not_an_error(monkeypatch):
    monkeypatch.delenv(serve.TOKEN_ENV, raising=False)
    assert serve.serve_token() == ""


# -- the four cases -----------------------------------------------------------------------------


def test_loopback_needs_no_token_and_that_must_not_regress(monkeypatch):
    monkeypatch.delenv(serve.TOKEN_ENV, raising=False)
    for host in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        allowed, code = _guard(host, {})
        assert allowed is True and code is None, host


def test_a_remote_peer_with_no_token_configured_is_refused(monkeypatch):
    monkeypatch.delenv(serve.TOKEN_ENV, raising=False)
    allowed, code = _guard("2001:db8::5", {})
    assert allowed is False and code == 403


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong"},
        {"Authorization": "wrong"},
        {"Authorization": "Bearer "},
        {"Authorization": "Basic s3cret"},
    ],
)
def test_a_remote_peer_without_the_right_bearer_is_refused(monkeypatch, headers):
    monkeypatch.setenv(serve.TOKEN_ENV, "s3cret")
    allowed, code = _guard("2001:db8::5", headers)
    assert allowed is False and code == 401


def test_a_remote_peer_with_the_right_bearer_is_admitted(monkeypatch):
    monkeypatch.setenv(serve.TOKEN_ENV, "s3cret")
    allowed, code = _guard("2001:db8::5", {"Authorization": "Bearer s3cret"})
    assert allowed is True and code is None


def test_the_refusal_body_does_not_say_which_half_was_wrong(monkeypatch):
    """Which half a prober got wrong is exactly what a prober wants told."""
    monkeypatch.setenv(serve.TOKEN_ENV, "s3cret")
    peer = _Peer("2001:db8::5", {"Authorization": "Bearer nearly-s3cret"})
    captured = {}
    peer._json = lambda code, payload: captured.update(code=code, payload=payload)
    serve.Handler._guard(peer)
    assert captured["payload"] == {"error": "unauthorized"}
    assert "s3cret" not in repr(captured["payload"])


def test_the_comparison_is_constant_time():
    """hmac.compare_digest is the standard-library answer; hand-rolling == here could not be
    justified later."""
    assert serve._constant_eq("abc", "abc") is True
    assert serve._constant_eq("abc", "abd") is False
    assert serve._constant_eq("abc", "") is False


# -- end to end ---------------------------------------------------------------------------------


def test_a_live_loopback_server_answers_without_a_token(monkeypatch, tmp_path, policy, receipts):
    """The whole point of keeping loopback token-free: this path is the one that ships."""
    monkeypatch.delenv(serve.TOKEN_ENV, raising=False)
    config = Config.load(tmp_path / "home", tmp_path / "work")
    lanes = {name: Lane(name, name, None) for name in ("flash", "fast", "deep")}
    context = serve.ServerContext(config, policy, lanes, receipts)
    bound = type("Bound", (serve.Handler,), {"context": context})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), bound)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.1)
    try:
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        with urllib.request.urlopen(base + "/status", timeout=20) as response:
            assert response.status == 200
            payload = json.loads(response.read())
        assert payload["effect_authority"] is False
        assert {lane["id"]: lane["up"] for lane in payload["lanes"]} == {
            "flash": False,
            "fast": False,
            "deep": False,
        }
    finally:
        httpd.shutdown()
        httpd.server_close()
