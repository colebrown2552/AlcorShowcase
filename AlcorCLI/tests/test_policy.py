"""The policy front door: programs lint clean, and every decision is bound to its inputs.

Adapted from the front-door, program-lint and kernel-precedence tests of the full system. A
program that cannot answer is *unavailable*, which is not the same as a program that said no.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from alcorcli import policy as policy_module
from alcorcli.errors import PolicyError
from alcorcli.policy import PolicyHost, parse_emitted, read_order

PACKAGE = Path(policy_module.__file__).resolve().parent
PROGRAMS = ("cli", "fallback_lane", "goal", "kernel", "memory", "tool")


def test_every_shipped_program_parses_and_checks_clean(policy):
    for name in PROGRAMS:
        report = policy.check(name)
        assert report["ok"], (name, report)


def test_every_shipped_program_has_a_host_in_the_package():
    haystack = "\n".join(p.read_text(encoding="utf-8") for p in PACKAGE.glob("*.py"))
    for name in PROGRAMS:
        assert name in haystack, name


def test_a_missing_cell_is_named_not_silently_shifted(policy):
    envelope = policy.run("memory", {"schema": "alcor.cli.memory.request.v1"}, "")
    assert envelope["status"] == "refused"
    assert "has_evidence" in envelope["error"]


def test_an_unknown_program_is_unavailable_not_a_no(policy):
    assert policy.run("does-not-exist", {}, "")["status"] == "unavailable"
    with pytest.raises(PolicyError):
        policy.decide("does-not-exist", {}, "x")


def test_duplicate_emitted_keys_and_malformed_lines_are_errors():
    assert parse_emitted("a=1\nb=2\n") == {"a": "1", "b": "2"}
    with pytest.raises(PolicyError):
        parse_emitted("a=1\na=2")
    with pytest.raises(PolicyError):
        parse_emitted("garbage")


def test_a_wrong_decision_schema_is_refused(policy, tmp_path):
    program = tmp_path / "t.alcor"
    program.write_text(
        'PROGRAM T WITH profile=default\nREAD $a\nEMIT "schema=t.decision.v1"\nEND PROGRAM\n',
        encoding="utf-8",
    )
    assert policy.run(program, {"a": "x"}, "t.decision.v1")["status"] == "decided"
    assert policy.run(program, {"a": "x"}, "other.v1")["status"] == "refused"


def test_a_trap_is_an_error_not_an_answer(policy, tmp_path):
    program = tmp_path / "trap.alcor"
    program.write_text(
        'PROGRAM T WITH profile=default\nREAD $n\nLET $m INT $n\nEMIT "schema=t.v1"\nEND PROGRAM\n',
        encoding="utf-8",
    )
    envelope = policy.run(program, {"n": "abc"}, "")
    assert envelope["status"] == "error"
    assert "trap" in envelope["error"]


def test_the_order_is_derived_from_the_program_so_a_caller_cannot_get_it_wrong(policy):
    source = policy.find_program("memory").read_text(encoding="utf-8")
    order = read_order(source)
    cells = {name: "no" for name in order}
    cells.update(schema="alcor.cli.memory.request.v1", effect_authority="false")
    shuffled = dict(reversed(list(cells.items())))
    a = policy.run("memory", cells, "")["decision"]
    b = policy.run("memory", shuffled, "")["decision"]
    assert a == b


def test_a_program_that_changes_while_it_runs_is_not_accepted(policy, tmp_path):
    program = tmp_path / "changing.alcor"
    program.write_text(
        'PROGRAM T WITH profile=default\nREAD $a\nEMIT "schema=t.v1"\nEND PROGRAM\n',
        encoding="utf-8",
    )
    runtime = policy.runtime()

    class Edits:
        def run(self, source, input_text="", base_dir=None):
            output = runtime.run(source, input_text=input_text, base_dir=base_dir)
            program.write_text(source.replace("t.v1", "t.v2"), encoding="utf-8")
            return output

    envelope = PolicyHost(runtime=Edits()).run(program, {"a": "x"}, "t.v1")
    assert envelope["status"] == "error"
    assert "changed-during-decision" in envelope["error"]


KERNEL_BASE = {
    "schema": "alcor.kernel.round.request.v1",
    "effect_authority": "false",
    "strategy_state": "selected",
    "round_failed": "no",
    "recover_tool_errors": "yes",
    "retries_exhausted": "no",
    "duplicate_in_round": "no",
    "stagnation_detected": "no",
    "force_final_after_duplicate": "yes",
    "budget_spent": "no",
    "half_spent": "no",
    "claims_done": "no",
    "check_state": "none",
    "verify_left": "2",
    "coach_note": "no",
    "solver_state": "none",
    "same_result": "none",
    "reread": "no",
    "children_pending": "no",
    "other_core_idle": "no",
    "unverified_write": "no",
    "claim_unchanged": "no",
}


def test_kernel_alcor_owns_the_round_precedence(policy):
    def ask(**over):
        got = policy.run("kernel", {**KERNEL_BASE, **over}, "alcor.kernel.round.decision.v1")
        assert got["status"] == "decided", got
        return got["decision"]

    assert ask()["action"] == "continue"
    assert ask(strategy_state="unavailable")["reason"] == "strategy-contract-not-selected"
    assert ask(strategy_state="unavailable")["action"] == "refuse"
    assert ask(half_spent="yes")["note"] == "half_spent"
    assert ask(budget_spent="yes")["reason"] == "budget"
    assert ask(duplicate_in_round="yes")["reason"] == "duplicate"
    assert ask(stagnation_detected="yes")["reason"] == "stagnation"
    assert ask(duplicate_in_round="yes", force_final_after_duplicate="no")["action"] == "continue"
    assert ask(round_failed="yes")["action"] == "continue"
    assert ask(round_failed="yes", retries_exhausted="yes")["reason"] == "tool_errors"
    assert ask(round_failed="yes", recover_tool_errors="no")["action"] == "fail"
    strict = ask(round_failed="yes", retries_exhausted="yes", budget_spent="yes")
    assert strict["reason"] == "tool_errors", "strict precedence: tool_errors before budget"
    assert ask(claims_done="yes", check_state="green")["action"] == "accept"
    assert ask(claims_done="yes", check_state="none")["action"] == "accept"
    assert ask(claims_done="yes", check_state="red")["action"] == "pushback"
    exhausted = ask(claims_done="yes", check_state="red", verify_left="0")
    assert exhausted["reason"] == "check_red_pushbacks_exhausted"


def test_the_agent_turn_asks_the_kernel_program_each_round():
    source = (PACKAGE / "agent.py").read_text(encoding="utf-8")
    assert "self._settle(" in source
    assert 'force_final = "duplicate"' not in source
