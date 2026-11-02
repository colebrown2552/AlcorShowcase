"""memory.alcor decides the admission kind; the host obeys.

``remember`` has three outcomes: stamped (evidence cited), testimony (it echoes what someone just
said to the agent) and unsourced. A claimed result with no evidence is refused, before any write.
"""

from __future__ import annotations

import pytest

from alcorcli.memory import Memory, MemoryLedger
from alcorcli.policy import PolicyHost


@pytest.fixture()
def memory(tmp_path, policy, scope, receipts):
    return Memory(
        MemoryLedger(tmp_path / "state" / "ledger.jsonl"),
        policy,
        heard_path=tmp_path / "state" / "heard.jsonl",
        pending_path=tmp_path / "state" / "pending.jsonl",
        receipts=receipts,
        scope=scope,
    )


def decision(memory, **cells):
    base = {
        "has_evidence": False,
        "evidence_failed": False,
        "echoes_heard": False,
        "asserts_result": False,
    }
    return memory._admission(**{**base, **cells})["kind"]


def test_program_exists(policy):
    assert policy.find_program("memory").is_file()


def test_kinds(memory):
    assert decision(memory, has_evidence=True, echoes_heard=True, asserts_result=True) == "stamped"
    assert decision(memory, echoes_heard=True, asserts_result=True) == "testimony"
    assert decision(memory, asserts_result=True) == "refuse"
    assert decision(memory, evidence_failed=True) == "evidence_unstamped"
    assert decision(memory) == "unsourced"


def test_claimed_result_without_evidence_is_refused_before_any_write(memory):
    out = memory.remember("the flux capacitor test passed and the coupling was verified")
    assert out["ok"] is False
    assert out["admission"] == "refused"
    assert "cite-the-check" in out["reason"]
    assert memory.ledger.entries() == []


def test_unavailable_program_refuses(memory, tmp_path):
    empty = tmp_path / "no-programs"
    empty.mkdir()
    memory.policy = PolicyHost(programs_dir=empty)
    assert decision(memory) == "refuse"


def test_three_outcomes(memory):
    got = memory.remember(
        "the count tool returns 20 on the 60-line fixture",
        "count",
        evidence="python count.py --selftest -> 20",
    )
    assert got["ok"] and got["admission"] == "stamped"
    memory.note_heard(
        "peer", "your aggregation really stands out: you scored 3 out of 3 on the counting tasks"
    )
    got = memory.remember("I scored 3 out of 3 on the counting tasks over long documents", "self")
    assert got["admission"] == "testimony"
    assert got["attributed_to"] == "peer"
    last = memory.ledger.entries()[-1]
    assert last["topic"] == "testimony"
    assert last["original_topic"] == "self"
    got = memory.remember("the deep lane answered the multihop probe at 90 percent fill", "needle")
    assert got["admission"] == "unsourced"


def test_evidence_beats_echo(memory):
    memory.note_heard("peer", "all three of tonight's errors were mine, not yours")
    got = memory.remember(
        "all three of tonight's errors were mine, not yours",
        evidence="check 7: two errors in the admin run, one in mine",
    )
    assert got["admission"] == "stamped"
