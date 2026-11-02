"""Telling the agent is not stopping it. The third identical failing call is refused.

One agent ran a single command sixteen times across six turns. It failed with a syntax error every
time. The harness was not silent: fifteen of the sixteen results carried a repeat note, the outcome
table called it malformed, and a better tool was named. All of it was text, and text is elective:
the model has to choose to read it. A refusal is not elective.

The rule is narrow on purpose. Re-running a command is often correct (that is how you watch a file
change), so this fires only when the *same* call has already failed twice with the *same* result,
the one case where a third attempt cannot teach anyone anything.
"""

from __future__ import annotations

import json

import pytest

from alcorcli.agent import LocalAgent
from alcorcli.fakes import ScriptedTransport, call
from alcorcli.ledger import ThreadLedger
from alcorcli.tools import ToolRegistry, ToolSpec

BROKEN = 'grep -qi teapot notes/fact.txt && python3 -c "import sys;"'


@pytest.fixture()
def drive(tmp_path, scope, policy):
    """Run `turns` turns of one agent whose model always asks for `command`."""

    def run(handler, command=BROKEN, turns=6):
        script = [call("shell", {"command": command}, f"c{i}") for i in range(12)]
        transport = ScriptedTransport(script)
        agent = LocalAgent(
            ledger=ThreadLedger(tmp_path / "t.jsonl", thread_id="rep"),
            transport=transport,
            model="local",
            tools=ToolRegistry(
                [ToolSpec("shell", "run", handler, mutating=True)], scope=scope, policy=policy
            ),
            policy=policy,
            owner_enabled=True,
        )
        for _ in range(turns):
            agent.turn("continue")
        return agent, json.dumps(transport.payloads)

    return run


def test_the_same_failing_call_stops_running_after_twice(drive):
    ran = {"n": 0}

    def handler(_args):
        ran["n"] += 1
        return {"ok": False, "outcome": "malformed", "return_code": 1, "stderr": "SyntaxError"}

    drive(handler)
    assert ran["n"] <= 2, f"it ran the same failing command {ran['n']} times"


def test_the_refusal_says_what_to_change(drive):
    def handler(_args):
        return {"ok": False, "outcome": "malformed", "return_code": 1, "stderr": "SyntaxError"}

    _, asked = drive(handler)
    assert "failed twice" in asked
    assert "change something" in asked


def test_a_command_whose_error_changes_keeps_running(drive):
    """A different error is new information; the agent is working through it."""
    seen = {"n": 0}

    def handler(_args):
        seen["n"] += 1
        return {
            "ok": False,
            "outcome": "failed",
            "return_code": 1,
            "stderr": f"error number {seen['n']}",
        }

    drive(handler, command="flaky")
    assert seen["n"] > 2, "a moving error was treated as a stuck one"


def test_a_command_that_starts_succeeding_is_never_refused(drive):
    """Re-running until something changes is how you watch a file appear."""
    seen = {"n": 0}

    def handler(_args):
        seen["n"] += 1
        ok = seen["n"] >= 2
        return {"ok": ok, "outcome": "ok" if ok else "failed", "stdout": "there" if ok else ""}

    agent, _ = drive(handler, command="test -f notes/x")
    assert agent._failed_twice == {}, "a success left the failure counter armed"


def test_a_different_command_is_untouched(tmp_path, scope, policy):
    def handler(_args):
        return {"ok": False, "outcome": "failed", "return_code": 1, "stderr": "no"}

    agent = LocalAgent(
        ledger=ThreadLedger(tmp_path / "t.jsonl", thread_id="rep"),
        transport=ScriptedTransport(
            [call("shell", {"command": "one"}, "c1"), call("shell", {"command": "two"}, "c2")]
        ),
        model="local",
        tools=ToolRegistry(
            [ToolSpec("shell", "run", handler, mutating=True)], scope=scope, policy=policy
        ),
        policy=policy,
        owner_enabled=True,
    )
    for _ in range(2):
        agent.turn("go")
    assert len(agent._failed_twice) == 2, "two distinct calls shared one counter"
