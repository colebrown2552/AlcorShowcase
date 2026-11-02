"""The command-line entry point: dispatch, the loopback rule, and the read-only default.

Adapted from the CLI tests of the full system. A loopback fake provider stands in for a model, so
the real guarded transport runs against a real socket.
"""

from __future__ import annotations

import io
import json

import pytest

from alcorcli.cli import main
from alcorcli.fakes import FakeProvider


def run(argv, policy, tmp_path, **kwargs):
    out, err = io.StringIO(), io.StringIO()
    code = main(
        ["--home", str(tmp_path / "home"), "--workspace", str(tmp_path / "work"), *argv],
        stdout=out,
        stderr=err,
        policy=policy,
        clock=lambda: 1_700_000_000.0,
        **kwargs,
    )
    return code, out.getvalue(), err.getvalue()


@pytest.fixture(autouse=True)
def workspace_exists(tmp_path):
    (tmp_path / "work").mkdir()


def test_empty_cli_prints_the_command_list(policy, tmp_path):
    code, out, _ = run([], policy, tmp_path)
    assert code == 0
    for command in ("doctor", "ask", "agent", "tool", "goal", "memory", "receipts", "serve"):
        assert command in out


def test_agent_rejects_a_non_loopback_endpoint(policy, tmp_path):
    code, out, err = run(
        [
            "agent",
            "--endpoint",
            "https://example.invalid/v1/chat/completions",
            "--thread",
            "cli",
            "hello",
        ],
        policy,
        tmp_path,
    )
    assert code == 2
    assert "endpoint-must-be-http-loopback" in err


def test_endpoint_route_answer_reaches_content_with_thinking_off(policy, tmp_path):
    """A provider that puts the answer in reasoning_content unless thinking is disabled."""
    with FakeProvider(model="local", script=["OK"]) as provider:
        code, out, err = run(
            [
                "agent",
                "--endpoint",
                provider.base,
                "--model",
                "local",
                "--thread",
                "wire",
                "--json",
                "hello",
            ],
            policy,
            tmp_path,
        )
        sent = provider.requests[0]
    assert code == 0, err
    assert sent["chat_template_kwargs"] == {"enable_thinking": False}
    assert sent["stream"] is False
    assert sent["model"] == "local"
    assert json.loads(out)["reply"] == "OK"


def test_plain_agent_stays_read_only_without_an_explicit_flag(policy, tmp_path):
    """Neither a standing environment nor a previous run selects an effectful tool set."""
    with FakeProvider(model="local", script=["fine"]) as provider:
        code, _, err = run(
            ["agent", "--endpoint", provider.base, "--model", "local", "--thread", "ro", "hello"],
            policy,
            tmp_path,
        )
        offered = {t["function"]["name"] for t in provider.requests[0]["tools"]}
    assert code == 0, err
    assert offered == {"read_file", "list_dir", "search_repo", "recall", "ask_owner"}


def test_explicit_allow_write_registers_the_effectful_tools(policy, tmp_path):
    with FakeProvider(model="local", script=["fine"]) as provider:
        code, _, err = run(
            [
                "agent",
                "--endpoint",
                provider.base,
                "--model",
                "local",
                "--thread",
                "rw",
                "--allow-write",
                "hello",
            ],
            policy,
            tmp_path,
        )
        offered = {t["function"]["name"] for t in provider.requests[0]["tools"]}
    assert code == 0, err
    assert {"write_file", "append_file", "edit_file", "remember"} <= offered
