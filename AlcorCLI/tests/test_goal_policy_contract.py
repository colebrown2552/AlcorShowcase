"""The goal caller retains and validates the real .alcor runtime decision receipt.

A receipt that is only retained proves nothing. The host recomputes every hash in it (program
bytes, cells, decision) and treats any mismatch as a halt, never as a decision.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from alcorcli.goal import DECISION_SCHEMA, MANY, GoalStore
from alcorcli.policy import PolicyHost


def probes(name):
    if name not in ("satisfaction", "progress"):
        raise AssertionError("unexpected probe")
    return {"ran": True, "rc": 1 if name == "satisfaction" else 0, "out": "baseline"}


def digest(value):
    text = json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(text.encode()).hexdigest()


class Recording(PolicyHost):
    """A policy host that keeps the envelopes it returned, and can tamper with them."""

    def __init__(self, runtime, tamper=None, after=None):
        super().__init__(runtime=runtime)
        self.seen = []
        self.tamper = tamper
        self.after = after

    def run(self, name, cells, expect_schema=""):
        envelope = super().run(name, cells, expect_schema)
        self.seen.append(json.loads(json.dumps(envelope)))
        if self.after is not None:
            self.after()
        if self.tamper is not None:
            self.tamper(envelope)
        return envelope


@pytest.fixture()
def make(tmp_path, policy):
    def build(tamper=None, after=None, program="goal"):
        host = Recording(policy.runtime(), tamper, after)
        store = GoalStore(
            tmp_path / "goals",
            host,
            runner=lambda command: probes("satisfaction" if command == "SAT" else "progress"),
            program=program,
        )
        goal = store.create("test objective", satisfaction="SAT", progress="PROG")
        return store, host, store.decompose(goal["id"], ["first", "second"])

    return build


def assert_host_halt(result, reason):
    assert result["verdict"] == "halt"
    assert result["reason"] == reason
    assert "policy_receipt" not in result
    assert "decision" not in result


def test_real_policy_receipt_binds_program_inputs_and_raw_decision(make, policy):
    store, host, goal = make()
    result = store.decide(goal)
    assert result["verdict"] == "pursue"
    assert result["policy_receipt"] == host.seen[0]["policy_receipt"]
    assert result["decision"] == host.seen[0]["decision"]
    receipt = result["policy_receipt"]
    program = policy.find_program("goal")
    assert receipt["program"] == "alcorcli/programs/goal.alcor"
    assert receipt["program_scope"] == "repository"
    assert receipt["program_sha256"] == hashlib.sha256(program.read_bytes()).hexdigest()
    assert receipt["decision_sha256"] == digest(result["decision"])
    assert receipt["input_sha256"] == digest(
        {"cells": result["cells"], "door": "tape", "expect_schema": DECISION_SCHEMA}
    )
    assert receipt["effect_authority"] is False
    assert result["decision"]["effect_authority"] == "false"


def test_every_canonical_verdict_retains_its_receipt(make):
    store, _, goal = make()
    cases = [
        ({}, False, "pursue"),
        ({"state": "stated"}, False, "decompose"),
        ({"approaches_tried": ["first"]}, False, "change-approach"),
        (
            {"last_progress": "baseline", "steps": [], "attempts": [{"approach": "first"}] * MANY},
            False,
            "escalate",
        ),
        ({}, True, "satisfied"),
        ({"budget_attempts": 0}, False, "halt"),
        ({"state": "abandoned"}, False, "refuse"),
    ]
    for updates, satisfied, expected in cases:
        store.runner = (
            (lambda command: {"ran": True, "rc": 0, "out": "baseline"})
            if satisfied
            else (lambda command: probes("satisfaction" if command == "SAT" else "progress"))
        )
        result = store.decide({**goal, **updates})
        assert result["verdict"] == expected, expected
        assert result["policy_receipt"]["decision_sha256"] == digest(result["decision"])


@pytest.mark.parametrize(
    ("replacement", "reason"),
    [
        (
            ("schema=alcor.goal.decision.v1", "schema=other.decision.v1"),
            "goal program did not decide",
        ),
        (("effect_authority=false", "effect_authority=true"), "goal program did not decide"),
        (("verdict=pursue", "verdict=execute-shell"), "goal-decision-verdict-invalid"),
    ],
)
def test_real_program_cannot_change_the_decision_contract(
    make, policy, tmp_path, replacement, reason
):
    changed = tmp_path / "changed.alcor"
    changed.write_text(
        policy.find_program("goal").read_text().replace(*replacement), encoding="utf-8"
    )
    store, _, goal = make(program=changed)
    result = store.decide(goal)
    assert result["verdict"] == "halt"
    assert result["reason"].startswith(reason)
    assert "policy_receipt" not in result


TAMPERINGS = [
    (None, "ok", False, "envelope-did-not-decide"),
    (None, "schema", "other", "envelope-did-not-decide"),
    (None, "decision", None, "decision-schema-mismatch"),
    ("decision", "schema", "other", "decision-schema-mismatch"),
    ("decision", "effect_authority", False, "decision-claimed-authority"),
    ("decision", "verdict", [], "receipt-decision-mismatch"),
    (None, "policy_receipt", None, "receipt-missing"),
    ("policy_receipt", "schema", "other", "receipt-missing"),
    ("policy_receipt", "effect_authority", "false", "receipt-claimed-authority"),
    ("policy_receipt", "program", "goal.alcor", "receipt-program-mismatch"),
    ("policy_receipt", "program_scope", "external", "receipt-program-mismatch"),
    ("policy_receipt", "program_sha256", "0" * 64, "receipt-source-mismatch"),
    (None, "door", "hosted", "receipt-door-invalid"),
    ("policy_receipt", "input_sha256", "0" * 64, "receipt-input-mismatch"),
    ("decision", "reason", "altered reason", "receipt-decision-mismatch"),
]


@pytest.mark.parametrize(("section", "field", "value", "reason"), TAMPERINGS)
def test_tampering_with_the_runtime_result_fails_closed(make, section, field, value, reason):
    def tamper(envelope):
        target = envelope if section is None else envelope[section]
        target[field] = value

    store, _, goal = make(tamper=tamper)
    assert_host_halt(store.decide(goal), f"goal program did not decide: {reason}")


def test_missing_program_does_not_become_a_policy_halt_receipt(make, tmp_path):
    store, _, goal = make(program=tmp_path / "missing.alcor")
    assert_host_halt(store.decide(goal), "goal program did not decide: program-unavailable")


def test_explicit_program_override_keeps_its_own_source_identity(make, policy, tmp_path):
    local = tmp_path / "local-goal.alcor"
    local.write_bytes(policy.find_program("goal").read_bytes())
    store, _, goal = make(program=local)
    result = store.decide(goal)
    assert result["verdict"] == "pursue"
    assert result["policy_receipt"]["program"] == local.name
    assert result["policy_receipt"]["program_scope"] == "external"


def test_source_changed_after_runtime_return_is_not_accepted(make, policy, tmp_path):
    local = tmp_path / "changed-after-run.alcor"
    local.write_bytes(policy.find_program("goal").read_bytes())

    def edit():
        local.write_text(
            local.read_text().replace("verdict=pursue", "verdict=halt"), encoding="utf-8"
        )

    store, _, goal = make(program=local, after=edit)
    assert_host_halt(store.decide(goal), "goal program did not decide: receipt-source-mismatch")


def test_malformed_or_unavailable_runtime_fails_closed(make, tmp_path, policy):
    store, host, goal = make()
    host.run = lambda *args, **kwargs: None
    assert_host_halt(store.decide(goal), "goal program did not decide: envelope-malformed")

    class Unavailable:
        def run(self, source, input_text="", base_dir=None):
            raise RuntimeError("unavailable")

    broken = GoalStore(tmp_path / "other", PolicyHost(runtime=Unavailable()), runner=store.runner)
    result = broken.decide(goal)
    assert result["verdict"] == "halt"
    assert result["reason"].startswith("goal program did not decide")
