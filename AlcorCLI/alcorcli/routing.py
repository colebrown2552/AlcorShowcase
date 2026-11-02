"""Provider selection: which lane answers a prompt, decided by a program from measured facts.

Routing is a bounded decision: finitely many inputs, finitely many outcomes, no I/O. That is what a
``.alcor`` program is for, so ``cli.alcor`` owns the decision and this host obeys it, instead of
the policy living as a thicket of ``if`` statements nobody can audit.

Two inputs are computed here and are never the model's or the program's to choose:

* **complexity**, estimated from the prompt before any model sees it. If a model judged its own
  difficulty it would have to run first, which is what routing exists to avoid.
* **lane state**, measured by probing each lane's ``/v1/models`` over loopback. A lane that is
  unconfigured, refused by the loopback rule, unreachable or serving the wrong model is *down*.
"""

from __future__ import annotations

import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .errors import EndpointRefused
from .policy import Decision, PolicyHost
from .transport import get_json

CLI_PROGRAM = "cli"
CLI_REQUEST_SCHEMA = "alcor.cli.request.v1"
CLI_DECISION_SCHEMA = "alcor.cli.decision.v1"

LANE_IDS = ("flash", "fast", "deep")
LANE_LABELS = {"flash": "small model lane", "fast": "mid-size lane", "deep": "large model lane"}

# Signals that a prompt wants the deep lane. Deliberately crude and readable: the point is that the
# choice is inspectable, not that the estimate is clever.
HARD_MARKERS = (
    "design",
    "why",
    "explain",
    "compare",
    "trade-off",
    "tradeoff",
    "architect",
    "refactor",
    "debug",
    "root cause",
    "prove",
    "analyz",
    "analys",
    "strategy",
    "should we",
    "plan",
    "review",
)
HARD_CHARS = 240


@dataclass(frozen=True)
class Lane:
    """One model lane: a name, a loopback base URL, and the model it is expected to serve.

    Attributes:
        id: ``flash``, ``fast`` or ``deep``.
        label: Human-readable role.
        base: ``http://127.0.0.1:<port>``, or None when the lane is not configured.
        expected_model: When set, the lane is down unless it serves a model whose file name
            contains this text, and every response must name exactly this model.
        max_tokens: Output cap for requests to this lane.
    """

    id: str
    label: str
    base: str | None
    expected_model: str = ""
    max_tokens: int = 700


@dataclass(frozen=True)
class LaneState:
    """What a probe measured.

    Attributes:
        up: True when the lane answered and serves the expected model.
        model: The model name the lane reported.
        ms: Probe latency.
        detail: Empty when up, otherwise a reason code such as ``endpoint-must-be-http-loopback``.
    """

    up: bool
    model: str
    ms: int
    detail: str


def lanes_from_env(environ: Mapping[str, str] | None = None) -> dict[str, Lane]:
    """Read lanes from ``ALCOR_LANE_<NAME>_BASE`` and ``ALCOR_LANE_<NAME>_MODEL``.

    A lane with no base is *unconfigured* and probes as down. There is deliberately no default
    address: ``127.0.0.1:<port>`` means a different model on every machine, so a default would
    be a guess.
    """
    env = os.environ if environ is None else environ
    lanes: dict[str, Lane] = {}
    for lane_id in LANE_IDS:
        prefix = f"ALCOR_LANE_{lane_id.upper()}_"
        lanes[lane_id] = Lane(
            id=lane_id,
            label=LANE_LABELS[lane_id],
            base=env.get(prefix + "BASE") or None,
            expected_model=env.get(prefix + "MODEL", ""),
            max_tokens=256 if lane_id == "flash" else 700,
        )
    return lanes


def estimate_complexity(prompt: str) -> str:
    """Return ``hard`` or ``simple`` from the prompt text alone, before any model runs."""
    text = (prompt or "").lower()
    if len(text) >= HARD_CHARS or any(marker in text for marker in HARD_MARKERS):
        return "hard"
    return "hard" if text.count("?") > 1 else "simple"


def probe(lane: Lane, timeout: float = 4.0) -> LaneState:
    """Measure one lane. Never raises: every failure is a reason code on a *down* state."""
    started = time.monotonic()

    def elapsed() -> int:
        return int((time.monotonic() - started) * 1000)

    if not lane.base:
        return LaneState(False, "", 0, "lane-not-configured")
    try:
        payload = get_json(lane.base, "/v1/models", timeout=timeout)
    except EndpointRefused as exc:
        return LaneState(False, "", elapsed(), exc.code)
    except Exception as exc:
        return LaneState(False, "", elapsed(), type(exc).__name__)
    rows: list[Any] = []
    if isinstance(payload, dict):
        rows = payload.get("data") or payload.get("models") or []
    first = rows[0] if rows and isinstance(rows[0], dict) else {}
    name = str(first.get("id") or first.get("name") or "")
    leaf = name.replace("\\", "/").rsplit("/", 1)[-1]
    # Containment, not equality: an exact match would call a healthy lane down after a requant
    # or a rename. What the check is for is "is this lane still serving the model it claims".
    if lane.expected_model and lane.expected_model.lower() not in leaf.lower():
        return LaneState(False, leaf, elapsed(), "model-mismatch")
    return LaneState(True, leaf or "unknown", elapsed(), "")


def probe_all(lanes: Mapping[str, Lane], timeout: float = 4.0) -> dict[str, LaneState]:
    """Probe every lane."""
    return {lane_id: probe(lane, timeout) for lane_id, lane in lanes.items()}


def cli_cells(program_id: str, **overrides: str) -> dict[str, str]:
    """The cells ``cli.alcor`` reads, with the safe default for every one.

    Defaults are the *safe* values: a caller that forgets ``owner_confirmed`` gets ``false`` and
    the admission is refused, never granted.
    """
    cells = {
        "schema": CLI_REQUEST_SCHEMA,
        "program_id": program_id,
        "effect_authority": "false",
        "requested_route": "auto",
        "complexity": "simple",
        "fast_state": "down",
        "flash_state": "down",
        "deep_state": "down",
        "memory_state": "unavailable",
        "owner_confirmed": "false",
        "lesson_state": "none",
        "tool_kind": "none",
    }
    cells.update(overrides)
    return cells


def cli_decide(policy: PolicyHost, program_id: str, **overrides: str) -> Decision:
    """Ask ``cli.alcor`` about one operation and return the verified decision.

    Raises:
        PolicyError: If the program is unavailable or its receipt does not verify.
    """
    return policy.decide(CLI_PROGRAM, cli_cells(program_id, **overrides), CLI_DECISION_SCHEMA)


def decide_route(
    policy: PolicyHost,
    prompt: str,
    *,
    requested: str,
    states: Mapping[str, LaneState],
    memory_ready: bool,
) -> Decision:
    """Choose a lane for ``prompt`` from the measured lane states.

    Args:
        policy: The policy host.
        prompt: The user's text; only its complexity is used.
        requested: ``auto``, ``flash``, ``fast`` or ``deep``.
        states: A probe result per lane id.
        memory_ready: Whether the memory ledger is available.
    """
    overrides = {
        f"{lane_id}_state": "up" if state.up else "down" for lane_id, state in states.items()
    }
    return cli_decide(
        policy,
        "cli-ask",
        requested_route=requested,
        complexity=estimate_complexity(prompt),
        memory_state="ready" if memory_ready else "unavailable",
        **overrides,
    )
