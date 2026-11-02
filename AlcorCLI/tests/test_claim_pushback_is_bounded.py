"""A pushback is delivered once; a re-claim with nothing changed is accepted and settled.

An agent wrote a hostname to a file in three calls, ran the check itself (green) and said DONE. A
kernel with a fresh pushback budget every turn pushed the claim back, the lane replied "say exactly
DONE", the agent did, and the kernel pushed back again: eight turns of identical rows. A claim
repeated with *no tool call in between* cannot be improved by pushing it back again, because the
note that would have improved it was already delivered. So there are three outcomes at a claim:
accept, push back once, or accept-as-repeated. The pushback's reason travels out in the turn
result so the lane can say it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from alcorcli.agent import Goal, LocalAgent
from alcorcli.fakes import ScriptedTransport, call, say
from alcorcli.ledger import ThreadLedger
from alcorcli.tools import ToolRegistry, ToolSpec

TASK = "Write the machine name to notes/host.txt"
GREEN = lambda: {"ok": True, "rc": 0}  # noqa: E731
RED = lambda: {"ok": False, "rc": 1, "output": "FAIL"}  # noqa: E731


@pytest.fixture()
def agent_for(tmp_path, scope, policy):
    def build(script, verifier):
        registry = ToolRegistry(
            [ToolSpec("shell", "run", lambda a: {"ok": True, "stdout": "ran"}, mutating=True)],
            scope=scope,
            policy=policy,
        )
        agent = LocalAgent(
            ledger=ThreadLedger(tmp_path / "t.jsonl", thread_id="claim"),
            transport=ScriptedTransport(script),
            model="local",
            tools=registry,
            policy=policy,
            owner_enabled=True,
            goal=Goal("You administer this machine.\n\nTASK:\n" + TASK, ()),
            verifier=verifier,
        )
        return agent

    return build


def test_a_green_check_is_accepted_the_first_time(agent_for):
    got = agent_for([say("DONE")], GREEN).turn(TASK)
    assert got["reply"] == "DONE"
    assert got["verify_pushbacks"] == 0, got
    assert got["check_state_at_claim"] == "green"


def test_a_repeated_claim_over_a_red_check_is_pushed_back_once_then_settled(agent_for):
    got = agent_for([say("DONE"), say("DONE")], RED).turn(TASK)
    assert got["verify_pushbacks"] == 1, got
    assert got["last_pushback"]["reason"] == "check_red"
    assert "FAIL" in got["last_pushback"]["note"]
    assert got["reply"] == "DONE"
    assert got["check_state_at_claim"] == "red", (
        "the lane still sees the red check and fails the task"
    )


def test_a_tool_call_between_claims_earns_a_fresh_pushback(agent_for):
    # DONE (pushed back) -> a call -> DONE (something changed: pushed back again) -> DONE (settled)
    script = [say("DONE"), call("shell", {"command": "echo again"}, "c1"), say("DONE"), say("DONE")]
    got = agent_for(script, RED).turn(TASK)
    assert got["verify_pushbacks"] == 2, got
    assert got["reply"] == "DONE"


def test_the_pushback_memory_outlives_the_turn(agent_for):
    # Turn 1: DONE -> pushback -> a sentence (turn ends, no claim). Turn 2, the lane's nudge:
    # DONE with nothing run since the pushback -> accepted, not pushed back for a second turn.
    agent = agent_for([say("DONE"), say("The task is complete."), say("DONE")], RED)
    first = agent.turn(TASK)
    second = agent.turn(
        "Continue. If the task is complete AND a command you ran has shown it, "
        "reply with exactly: DONE"
    )
    assert first["verify_pushbacks"] == 1
    assert first["reply"] == "The task is complete."
    assert first["last_pushback"]["reason"] == "check_red", "the lane can name the reason next time"
    assert second["verify_pushbacks"] == 0, second
    assert second["reply"] == "DONE"
    assert second["claim_settled_as"] == "repeat_claim_nothing_changed"


def test_the_policy_lives_in_the_program(policy):
    source = Path(policy.find_program("kernel")).read_text(encoding="utf-8")
    assert "READ $claim_unchanged" in source
    assert "repeat-claim-nothing-changed" in source
