"""The fallback lane: what the gate may do when every local model lane is down.

The host supplies measured lane states as named cells. ``fallback_lane.alcor`` owns the finite
routing decision. The fallback is coordination only: it never becomes a model provider, an
executor, a shell or an authority source, and the only operations it ever names are
``observe``, ``submit_exact_sha_patch_request`` and ``read_receipts``.

The host checks the program's answer against that contract field by field, so a program (or a
tampered copy of one) cannot widen what the fallback is allowed to do.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from .errors import PolicyError
from .policy import PROGRAM_DIR, PolicyHost

REQUEST_SCHEMA = "alcor.fallback-lane.request.v1"
DECISION_SCHEMA = "alcor.fallback-lane.decision.v1"
PROGRAM = PROGRAM_DIR / "fallback_lane.alcor"
DECISION_FIELDS = frozenset(
    {"schema", "eligible", "route", "reason", "operations", "model_authority", "effect_authority"}
)
ALLOWED_OPERATIONS = ("observe", "submit_exact_sha_patch_request", "read_receipts")
ROUTES = frozenset({"none", "remote-fallback"})


class FallbackLaneError(RuntimeError):
    """The fallback policy could not be consulted safely."""


def _state(value: bool, name: str) -> str:
    if type(value) is not bool:
        raise FallbackLaneError(f"state-type:{name}")
    return "up" if value else "down"


def _unwrap_policy_envelope(envelope: Mapping[str, Any]) -> dict[str, Any]:
    """Accept a raw decision, or an ``alcor.program.v1`` envelope that actually decided."""
    if envelope.get("schema") != "alcor.program.v1":
        return dict(envelope)
    if envelope.get("ok") is not True or envelope.get("status") != "decided":
        raise FallbackLaneError("policy-did-not-decide")
    receipt = envelope.get("policy_receipt")
    if (
        not isinstance(receipt, Mapping)
        or receipt.get("schema") != "alcor.program.decision-receipt.v1"
    ):
        raise FallbackLaneError("policy-receipt-missing")
    if receipt.get("effect_authority") is not False:
        raise FallbackLaneError("policy-receipt-claimed-authority")
    raw = envelope.get("decision")
    if not isinstance(raw, Mapping):
        raise FallbackLaneError("policy-decision-missing")
    return dict(raw)


def fallback_decision(
    *,
    fast_up: bool,
    deep_up: bool,
    flash_up: bool,
    fallback_installed: bool,
    policy: PolicyHost | None = None,
    policy_runner: Callable[..., Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return the program-owned decision for the current lane states.

    Args:
        fast_up: Whether the mid-size lane answered its probe.
        deep_up: Whether the large lane answered.
        flash_up: Whether the small lane answered. Any live lane suppresses the fallback.
        fallback_installed: Whether a fallback route is configured at all.
        policy: The policy host used when no ``policy_runner`` is given. Its receipt is verified.
        policy_runner: A seam for tests: ``(program, cells, expect_schema=...) -> envelope``.

    Raises:
        FallbackLaneError: If the policy cannot be consulted, claims authority, or answers
            outside the fallback contract.
    """
    cells = {
        "schema": REQUEST_SCHEMA,
        "effect_authority": "false",
        "fast_state": _state(fast_up, "fast"),
        "deep_state": _state(deep_up, "deep"),
        "flash_state": _state(flash_up, "flash"),
        "fallback_state": "installed"
        if _state(fallback_installed, "fallback") == "up"
        else "missing",
    }
    if policy_runner is not None:
        try:
            envelope = dict(policy_runner(str(PROGRAM), cells, expect_schema=DECISION_SCHEMA))
        except FallbackLaneError:
            raise
        except Exception as exc:
            raise FallbackLaneError(f"policy-front-door-failed:{type(exc).__name__}") from exc
        raw = _unwrap_policy_envelope(envelope)
    else:
        try:
            raw = dict((policy or PolicyHost()).decide(PROGRAM, cells, DECISION_SCHEMA).fields)
        except PolicyError as exc:
            raise FallbackLaneError(f"policy-front-door-failed:{exc.code}") from exc
    if set(raw) != DECISION_FIELDS:
        raise FallbackLaneError("decision-fields")
    decision = {
        str(key): str(value).lower() if isinstance(value, bool) else str(value)
        for key, value in raw.items()
    }
    if decision.get("schema") != DECISION_SCHEMA:
        raise FallbackLaneError("decision-schema")
    if decision.get("model_authority") != "false" or decision.get("effect_authority") != "false":
        raise FallbackLaneError("decision-claimed-authority")
    if decision.get("route") not in ROUTES:
        raise FallbackLaneError("decision-route")
    operations_text = decision.get("operations", "")
    operations: list[str] = [] if operations_text == "none" else operations_text.split(",")
    if operations and tuple(operations) != ALLOWED_OPERATIONS:
        raise FallbackLaneError("decision-operations")
    eligible = decision.get("eligible")
    if eligible not in {"true", "false"}:
        raise FallbackLaneError("decision-eligible")
    if (eligible == "true") != (decision.get("route") == "remote-fallback"):
        raise FallbackLaneError("decision-inconsistent")
    return {
        "schema": DECISION_SCHEMA,
        "eligible": eligible == "true",
        "route": decision["route"],
        "reason": decision["reason"],
        "model_authority": False,
        "effect_authority": False,
        "machine_operations": operations,
    }
