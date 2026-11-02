"""The fallback lane: data-only coordination when every local model lane is down."""

from __future__ import annotations

from pathlib import Path

import pytest

from alcorcli import fallback_lane


def raw_policy(program: str, cells: dict[str, str], *, expect_schema: str):
    assert Path(program).name == "fallback_lane.alcor"
    assert expect_schema == fallback_lane.DECISION_SCHEMA
    base = {
        "schema": fallback_lane.DECISION_SCHEMA,
        "eligible": "false",
        "route": "none",
        "reason": "local-model-lane-available",
        "operations": "none",
        "model_authority": "false",
        "effect_authority": "false",
    }
    if all(cells[name] == "down" for name in ("fast_state", "deep_state", "flash_state")):
        if cells["fallback_state"] == "installed":
            base.update(
                eligible="true",
                route="remote-fallback",
                reason="all-local-model-lanes-unavailable",
                operations="observe,submit_exact_sha_patch_request,read_receipts",
            )
        else:
            base["reason"] = "fallback-not-installed"
    return base


def test_all_local_lanes_down_enables_data_only_fallback():
    decision = fallback_lane.fallback_decision(
        fast_up=False,
        deep_up=False,
        flash_up=False,
        fallback_installed=True,
        policy_runner=raw_policy,
    )
    assert decision["eligible"] is True
    assert decision["route"] == "remote-fallback"
    assert decision["machine_operations"] == [
        "observe",
        "submit_exact_sha_patch_request",
        "read_receipts",
    ]
    assert decision["model_authority"] is False
    assert decision["effect_authority"] is False


def test_the_small_lane_blocks_fallback():
    decision = fallback_lane.fallback_decision(
        fast_up=False,
        deep_up=False,
        flash_up=True,
        fallback_installed=True,
        policy_runner=raw_policy,
    )
    assert decision["eligible"] is False
    assert decision["reason"] == "local-model-lane-available"


def test_missing_install_fails_closed():
    decision = fallback_lane.fallback_decision(
        fast_up=False,
        deep_up=False,
        flash_up=False,
        fallback_installed=False,
        policy_runner=raw_policy,
    )
    assert decision["eligible"] is False
    assert decision["reason"] == "fallback-not-installed"


def test_source_bound_front_door_receipt_is_checked():
    def envelope(program, cells, *, expect_schema):
        return {
            "schema": "alcor.program.v1",
            "ok": True,
            "status": "decided",
            "decision": raw_policy(program, cells, expect_schema=expect_schema),
            "policy_receipt": {
                "schema": "alcor.program.decision-receipt.v1",
                "effect_authority": False,
            },
        }

    decision = fallback_lane.fallback_decision(
        fast_up=False,
        deep_up=False,
        flash_up=False,
        fallback_installed=True,
        policy_runner=envelope,
    )
    assert decision["eligible"] is True


def test_invalid_state_or_policy_authority_is_rejected():
    with pytest.raises(fallback_lane.FallbackLaneError, match="state-type"):
        fallback_lane.fallback_decision(
            fast_up="false",  # type: ignore[arg-type]
            deep_up=False,
            flash_up=False,
            fallback_installed=True,
            policy_runner=raw_policy,
        )

    def bad(program, cells, *, expect_schema):
        value = raw_policy(program, cells, expect_schema=expect_schema)
        value["effect_authority"] = "true"
        return value

    with pytest.raises(fallback_lane.FallbackLaneError, match="claimed-authority"):
        fallback_lane.fallback_decision(
            fast_up=False, deep_up=False, flash_up=False, fallback_installed=True, policy_runner=bad
        )


def test_program_is_closed_and_effectless():
    source = fallback_lane.PROGRAM.read_text(encoding="utf-8")
    assert "PROGRAM AlcorFallbackLane" in source
    assert 'BRANCH EQ $flash_state "up" local_available' in source
    assert 'EMIT "effect_authority=false"' in source
    for forbidden in ("EXEC", "SHELL", "HTTP", "DOWNLOAD"):
        assert forbidden not in source.upper()
