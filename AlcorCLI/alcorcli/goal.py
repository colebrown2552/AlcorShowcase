"""A goal that outlives the agent's memory, and progress it cannot talk itself into.

Two failure modes show up in autonomous loops. In one, a loop keeps pressing the same key for
hours: every action legal, every receipt clean, the room unchanged. That is persistence with
nothing to persist *at*. In the other, a real objective dissolves at every context compaction, so
each turn re-derives the task from a file and spends its budget re-reading instead of working.

The cure is the same for both. An intention has to live somewhere the agent cannot forget it, and
movement has to be measured by something that is not the agent's own impression of moving. So a
goal is three things, and the second two are what make it real:

    objective     prose: what the operator means to bring about.
    satisfaction  a COMMAND. Exit zero means finished. There is no other way to finish.
    progress      a COMMAND whose output changes when the world moves. Not a feeling.

"Stalled" is the progress probe returning what it returned last time. "Many attempts" is a count
on disk, not a sense of deja vu. "Done" is an exit code someone else could re-run. And because the
record is a file, a restart or a new process resumes the same pursuit.

What this refuses to do: call a goal finished on the agent's say-so (satisfaction is checked or
the goal halts), run an unmeasurable goal (motion that cannot be told from work), or quietly
resume an abandoned goal. It holds no effect authority of its own. ``goal.alcor`` decides what
should happen next, and something else must have the standing to do it.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shlex
import subprocess
import time
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .digest import sha256_hex, utc_iso
from .errors import PolicyError, ReceiptError, ToolDenied
from .fsutil import atomic_replace
from .policy import PolicyHost
from .portable_lock import sidecar_lock
from .receipts import ReceiptLog

SCHEMA = "alcor.goal.record.v1"
REQUEST = "alcor.goal.request.v1"
DECISION_SCHEMA = "alcor.goal.decision.v1"
GOAL_PROGRAM = "goal"
DECISION_VERDICTS = frozenset(
    {"pursue", "decompose", "change-approach", "escalate", "satisfied", "halt", "refuse"}
)
# "Many" has to be a number or it is a mood. Five attempts on one approach with nothing moving is
# where a person would stop and think, so it is where the agent does.
FEW = 2
MANY = 5
_GOAL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")

Runner = Callable[[str], dict[str, Any]]


def command_runner(*, timeout: float = 60.0, admit: Callable[[str], None] | None = None) -> Runner:
    """Build the default probe runner: run a command without a shell and report what happened.

    Args:
        timeout: Seconds a probe may take.
        admit: Called with the command before it runs. It raises ``ToolDenied`` to refuse, which
            lets a caller put even operator-authored probes behind the effect gate.

    Returns:
        A function from a command to ``{"rc", "out", "ran"}``. ``ran`` is False when the command
        could not be started, which is *unavailable*, not failure.
    """

    def run(command: str) -> dict[str, Any]:
        if admit is not None:
            try:
                admit(command)
            except ToolDenied as exc:
                return {"rc": None, "out": "", "ran": False, "error": exc.reason}
        try:
            argv = command if os.name == "nt" else shlex.split(command)
            done = subprocess.run(
                argv, capture_output=True, text=True, timeout=timeout, check=False
            )
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            return {"rc": None, "out": "", "ran": False, "error": type(exc).__name__}
        return {"rc": done.returncode, "out": (done.stdout or "").strip()[:400], "ran": True}

    return run


class GoalStore:
    """Goal records on disk, and the decisions about them.

    Args:
        root: Directory holding one ``<goal id>.json`` per goal.
        policy: Runs ``goal.alcor``.
        runner: Runs probe commands. Defaults to ``command_runner()``.
        receipts: Decisions and state changes are recorded here as hashes.
        clock: Returns epoch time.
        program: The decision program. Another path is allowed, and keeps its own identity.
    """

    def __init__(
        self,
        root: Path | str,
        policy: PolicyHost,
        *,
        runner: Runner | None = None,
        receipts: ReceiptLog | None = None,
        clock: Callable[[], float] = time.time,
        program: Path | str = GOAL_PROGRAM,
    ) -> None:
        self.root = Path(root)
        self.policy = policy
        self.program = program
        self.runner = runner or command_runner()
        self.receipts = receipts
        self._clock = clock

    # -- the record ----------------------------------------------------------------------------

    def _path(self, goal_id: str) -> Path:
        # An id becomes a file name, so it may not carry a separator or a dot-dot.
        if not _GOAL_ID.fullmatch(str(goal_id)):
            raise ValueError("goal id may only use letters, digits, dot, dash and underscore")
        return self.root / f"{goal_id}.json"

    def _save(self, goal: Mapping[str, Any]) -> None:
        path = self._path(goal["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(goal, indent=1, sort_keys=True) + "\n"
        with sidecar_lock(path):
            atomic_replace(path, payload.encode("utf-8"))

    def _receipt(self, kind: str, body: Mapping[str, Any]) -> None:
        if self.receipts is None:
            return
        # The goal file is the record; a missed receipt shows up in `receipts verify`.
        with contextlib.suppress(ReceiptError):
            self.receipts.append(kind, body)

    def load(self, goal_id: str) -> dict[str, Any]:
        """Read one goal. Raises ``FileNotFoundError`` if there is none."""
        return json.loads(self._path(goal_id).read_text(encoding="utf-8"))

    def goals(self) -> list[dict[str, Any]]:
        """Every readable goal, in id order."""
        if not self.root.is_dir():
            return []
        found = []
        for file in sorted(self.root.glob("*.json")):
            try:
                found.append(json.loads(file.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return found

    def create(
        self,
        objective: str,
        *,
        satisfaction: str,
        progress: str,
        owner: str = "operator",
        budget_attempts: int = 40,
        goal_id: str | None = None,
    ) -> dict[str, Any]:
        """State a goal. Both checks are required: a goal you cannot finish or measure is a wish."""
        if not objective.strip():
            raise ValueError("a goal needs an objective")
        if not satisfaction.strip():
            raise ValueError(
                "a goal needs a satisfaction check: without one it can only be claimed done"
            )
        if not progress.strip():
            raise ValueError("a goal needs a progress probe: without one, stalling is invisible")
        goal = {
            "schema": SCHEMA,
            "id": goal_id or "goal-" + uuid.uuid4().hex[:8],
            "objective": objective.strip(),
            "satisfaction": satisfaction.strip(),
            "progress": progress.strip(),
            "owner": owner,
            "state": "stated",  # stated -> pursuing -> satisfied | abandoned
            "created_utc": utc_iso(self._clock()),
            "steps": [],  # the decomposition; the head is the current step
            "approach": None,  # what the agent is currently trying
            "approaches_tried": [],  # and what it has already refuted
            "attempts": [],  # one row per try, with the probe before and after
            "budget_attempts": int(budget_attempts),
            "last_progress": None,
            "escalations": [],
        }
        self._save(goal)
        self._receipt(
            "goal.created",
            {"id": goal["id"], "objective_sha256": sha256_hex(goal["objective"]), "owner": owner},
        )
        return goal

    # -- the two probes ------------------------------------------------------------------------

    def check_satisfaction(self, goal: Mapping[str, Any]) -> str:
        """Return ``passing``, ``failing`` or ``unavailable``.

        Unavailable is not failing: it means the host could not tell.
        """
        try:
            got = self.runner(goal["satisfaction"])
        except Exception:
            return "unavailable"  # A failed measurement is not a negative world result.
        if (
            not isinstance(got, Mapping)
            or got.get("ran") is not True
            or type(got.get("rc")) is not int
            or got["rc"] < 0
        ):
            return "unavailable"
        return "passing" if got["rc"] == 0 else "failing"

    def read_progress(self, goal: Mapping[str, Any]) -> dict[str, Any]:
        """The probe's current reading, and whether it moved since last time."""
        try:
            got = self.runner(goal["progress"])
        except Exception:
            return {
                "state": "unmeasured",
                "reading": None,
            }  # Do not mistake transport failure for progress.
        if (
            not isinstance(got, Mapping)
            or got.get("ran") is not True
            or type(got.get("rc")) is not int
            or got["rc"] != 0
            or not isinstance(got.get("out"), str)
        ):
            return {"state": "unmeasured", "reading": None}
        reading, last = got["out"], goal.get("last_progress")
        if last is None:
            return {"state": "advancing", "reading": reading}
        return {"state": "stalled" if reading == last else "advancing", "reading": reading}

    # -- deciding ------------------------------------------------------------------------------

    @staticmethod
    def _attempts_on_approach(goal: Mapping[str, Any]) -> int:
        current = goal.get("approach")
        return sum(1 for a in goal.get("attempts", []) if a.get("approach") == current)

    def cells(self, goal: Mapping[str, Any], *, satisfaction: str, progress: str) -> dict[str, str]:
        """The facts ``goal.alcor`` decides on, all derived from the record and the probes."""
        n = self._attempts_on_approach(goal)
        spent = len(goal.get("attempts", [])) >= int(goal.get("budget_attempts", 40))
        refuted = goal.get("approach") in goal.get("approaches_tried", [])
        return {
            "schema": REQUEST,
            "effect_authority": "false",
            "goal_state": goal.get("state", "unstated"),
            "satisfaction": satisfaction,
            "progress": progress,
            "approach_attempts": "none" if n == 0 else ("many" if n >= MANY else "few"),
            "approach_state": "refuted" if refuted else "working",
            # An alternative is available while the agent has not exhausted the steps it decomposed.
            "alternatives": (
                "available"
                if len(goal.get("steps", [])) > len(goal.get("approaches_tried", []))
                else "exhausted"
            ),
            "budget": "spent" if spent else "available",
            "owner_grant": "present" if goal.get("owner") else "absent",
        }

    def decide(self, goal: Mapping[str, Any]) -> dict[str, Any]:
        """What should happen next, with the exact decision and a verified receipt.

        A host halt is not a policy decision: failures carry no policy receipt. The raw decision
        is kept beside the verdict so a consumer can check its digest.
        """
        satisfaction = self.check_satisfaction(goal)
        progress = self.read_progress(goal)
        cells = self.cells(goal, satisfaction=satisfaction, progress=progress["state"])

        def halt(reason: str) -> dict[str, Any]:
            return {
                "verdict": "halt",
                "reason": reason,
                "cells": cells,
                "reading": progress.get("reading"),
                "satisfaction": satisfaction,
            }

        try:
            decision = self.policy.decide(self.program, cells, DECISION_SCHEMA)
        except PolicyError as exc:
            return halt(f"goal program did not decide: {exc.code}")
        verdict, reason = decision.get("verdict"), decision.get("reason")
        if verdict not in DECISION_VERDICTS:
            return halt("goal-decision-verdict-invalid")
        if not reason.strip():
            return halt("goal-decision-reason-invalid")
        result = {
            "verdict": verdict,
            "reason": reason,
            "cells": cells,
            "reading": progress.get("reading"),
            "satisfaction": satisfaction,
            "decision": dict(decision.fields),
            "policy_receipt": dict(decision.receipt),
        }
        self._receipt(
            "goal.decision",
            {
                "id": goal.get("id"),
                "verdict": verdict,
                "reason": reason,
                "satisfaction": satisfaction,
                "progress": progress["state"],
                "policy_receipt": dict(decision.receipt),
            },
        )
        return result

    # -- acting on the decision ----------------------------------------------------------------

    def decompose(self, goal_id: str, steps: list[str]) -> dict[str, Any]:
        """Give the goal its next steps. The head becomes the current approach."""
        goal = self.load(goal_id)
        goal["steps"] = [str(s).strip() for s in steps if str(s).strip()]
        if not goal["steps"]:
            raise ValueError("a decomposition with no steps is not a decomposition")
        goal["approach"] = goal["steps"][0]
        goal["state"] = "pursuing"
        self._save(goal)
        return goal

    def change_approach(self, goal_id: str, *, to: str | None = None) -> dict[str, Any]:
        """Retire the current approach as refuted and take the next one. This is the anti-loop."""
        goal = self.load(goal_id)
        current = goal.get("approach")
        if current and current not in goal["approaches_tried"]:
            goal["approaches_tried"].append(current)
        remaining = [s for s in goal.get("steps", []) if s not in goal["approaches_tried"]]
        goal["approach"] = to or (remaining[0] if remaining else None)
        # A new approach gets a clean reading, not the old one's stall. Otherwise its first
        # attempt would inherit the last approach's failure and be condemned before it runs.
        goal["last_progress"] = None
        self._save(goal)
        return goal

    def record_attempt(
        self, goal_id: str, *, before: str | None, after: str | None, note: str = ""
    ) -> dict[str, Any]:
        """One try, with the probe on both sides. This is what makes "many attempts" a fact."""
        goal = self.load(goal_id)
        goal["attempts"].append(
            {
                "utc": utc_iso(self._clock()),
                "approach": goal.get("approach"),
                "before": before,
                "after": after,
                "moved": bool(before != after),
                "note": note[:200],
            }
        )
        goal["last_progress"] = after
        self._save(goal)
        return goal

    def attempt(self, goal_id: str, action: Callable[[], Any], *, note: str = "") -> dict[str, Any]:
        """Read the probe, act, read it again. The agent never reports its own progress."""
        goal = self.load(goal_id)
        before = self.runner(goal["progress"]).get("out")
        result = None
        try:
            result = action()
        except Exception as exc:
            note = (note + f" | action raised {type(exc).__name__}").strip(" |")
        after = self.runner(goal["progress"]).get("out")
        goal = self.record_attempt(goal_id, before=before, after=after, note=note)
        return {
            "goal": goal,
            "moved": before != after,
            "before": before,
            "after": after,
            "result": result,
        }

    def escalate(self, goal_id: str, why: str) -> dict[str, Any]:
        """Hand the next move to the operator, recording what was tried."""
        goal = self.load(goal_id)
        goal["escalations"].append(
            {
                "utc": utc_iso(self._clock()),
                "why": why[:300],
                "approaches_tried": list(goal.get("approaches_tried", [])),
            }
        )
        self._save(goal)
        self._receipt(
            "goal.escalated",
            {"id": goal_id, "why_sha256": sha256_hex(why), "tried": len(goal["approaches_tried"])},
        )
        return goal

    def finish(self, goal_id: str) -> dict[str, Any]:
        """Mark satisfied, but only if the check actually passes right now."""
        goal = self.load(goal_id)
        satisfaction = self.check_satisfaction(goal)
        if satisfaction != "passing":
            return {
                "ok": False,
                "state": goal["state"],
                "why": f"satisfaction is {satisfaction}; a goal is finished by its check, "
                "never by asking",
            }
        goal["state"] = "satisfied"
        goal["satisfied_utc"] = utc_iso(self._clock())
        self._save(goal)
        self._receipt("goal.satisfied", {"id": goal_id, "attempts": len(goal["attempts"])})
        return {"ok": True, "state": "satisfied", "attempts": len(goal["attempts"])}

    def abandon(self, goal_id: str, why: str) -> dict[str, Any]:
        """Abandon a goal. Resuming it is the operator's call, not a drift back into it."""
        goal = self.load(goal_id)
        goal["state"] = "abandoned"
        goal["abandoned_utc"] = utc_iso(self._clock())
        goal["abandoned_why"] = why[:300]
        self._save(goal)
        return goal
