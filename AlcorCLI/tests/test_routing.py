"""Hermetic routing checks: cli.alcor picks a lane from measured lane states.

Adapted from the routing tests for the small, fast-speed lane. The program is data-only: it emits a
route and a reason, never a command.
"""

from __future__ import annotations

import json

from alcorcli.routing import CLI_DECISION_SCHEMA, cli_cells


def decide(policy, **overrides):
    cells = cli_cells(
        "cli-ask",
        requested_route="auto",
        complexity="simple",
        fast_state="up",
        flash_state="up",
        deep_state="up",
        memory_state="ready",
    )
    cells.update(overrides)
    return policy.decide("cli", cells, CLI_DECISION_SCHEMA)


def test_simple_auto_prefers_flash(policy):
    got = decide(policy)
    assert got["accepted"] == "true"
    assert got["route"] == "flash"
    assert got["reason"] == "simple-task-to-flash-lane"


def test_explicit_flash_refuses_when_unreachable(policy):
    got = decide(policy, requested_route="flash", flash_state="down")
    assert got["accepted"] == "false"
    assert got["route"] == "none"
    assert got["reason"] == "selected-lane-unreachable"


def test_simple_auto_degrades_to_the_fast_lane(policy):
    got = decide(policy, flash_state="down")
    assert got["route"] == "fast"
    assert got["reason"] == "simple-task-to-fast-lane"


def test_hard_auto_stays_on_deep_before_flash(policy):
    got = decide(policy, complexity="hard")
    assert got["route"] == "deep"
    assert got["reason"] == "hard-task-to-deep-lane"


def test_decision_remains_data_only(policy):
    got = decide(policy, requested_route="flash")
    assert got["effect_authority"] == "false"
    assert "execute" not in json.dumps(dict(got.fields)).lower()
