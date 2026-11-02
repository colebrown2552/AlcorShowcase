"""The local agent: a bounded loop that talks to a model and can only act through the gate.

One ``turn`` takes a user message and runs rounds until the model answers in prose. Each round is
one model call followed by the tool calls it asked for. The loop itself decides almost nothing:

* **Every tool call is admitted by ``tool.alcor``** (see ``tools.ToolRegistry``). A refusal comes
  back to the model as data it can read and change course on.
* **Every round ends with a decision from ``kernel.alcor``**: continue, finalize, push back,
  accept, fail or refuse. The host computes the arithmetic into yes/no cells (budget spent? same
  call twice? tool failed? a claim of DONE while the check is red?) and the program owns the
  precedence between them. A missing or refusing program stops the turn; a turn does not continue
  on "none".
* **A claim of DONE is checked, not believed.** The task's own check runs; if it is red, or the
  agent changed a file and never read it back, the claim is pushed back with the reason. A pushback
  is delivered once: repeating a claim with nothing run since cannot improve it, so the second
  identical claim is accepted and the host's check settles it.
* **The full ledger stays on disk.** The model sees a bounded projection of it, and a final answer
  is committed in two steps so a crash cannot replay a draft as accepted history.

Cells that belong to features outside this carve-out (a coach, child tasks, a second core, a
solver tool) are supplied with neutral values, so ``kernel.alcor`` is exactly the program the full
system runs.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .context import ContextCompactor
from .digest import sha256_hex
from .errors import AgentRuntimeError, PolicyError, ReceiptError, ToolDenied, TurnInterrupted
from .guard import TurnGuard
from .ledger import AgentMessage, CompletionPersistenceUncertain, ThreadLedger
from .limits import MAX_GOAL_CHARS, bounded_text
from .policy import PolicyHost
from .receipts import ReceiptLog
from .repeat import prior_call_history, repeat_note, with_repeat_note
from .tools import ToolRegistry
from .transport import (
    ChatTransport,
    ReceiptingTransport,
    completion_message,
    normalise_tool_call,
)

KERNEL_PROGRAM = "kernel"
KERNEL_REQUEST_SCHEMA = "alcor.kernel.round.request.v1"
KERNEL_DECISION_SCHEMA = "alcor.kernel.round.decision.v1"
RESULT_SCHEMA = "alcor.cli.agent-result.v1"
VERIFY_PUSHBACKS = 2
STAGNATION_STREAK = 3

WRITE_TOOLS = frozenset({"write_file", "append_file", "edit_file"})
READ_BACK_TOOLS = frozenset({"read_file"})
_CLAIM_STRIP = "*_`# \t"
_NUMBER = re.compile(r"[0-9]*\.?[0-9]+")

# What the model is told when the loop asks it to stop. One message per reason, because "you
# repeated a tool", "your budget is gone" and "your tools keep failing" call for different answers,
# and a single generic line invites the model to explain the wrong thing.
FINAL_INSTRUCTION = {
    "duplicate": (
        "The exact tool result above has already been provided. Do not call that tool again; "
        "answer the user's request now using the available result, or state what remains unknown."
    ),
    "budget": (
        "Your tool budget for this turn is spent. Answer now with what you have. If the task is "
        "unfinished, say exactly what you did, what you did not do, and what you would do next; "
        "do not claim it is complete."
    ),
    "tool_errors": (
        "Your tools have failed repeatedly, so no more will be run this turn. Report what you were "
        "attempting, what the failures were, and what you established before they started. Do not "
        "claim a result you did not obtain."
    ),
    "stagnation": (
        "You issued the exact same tool call three times consecutively. Stop repeating it and "
        "reassess the goal from the receipts already present. Answer with what changed, what did "
        "not, and the next different observation or method required."
    ),
}


def claims_done(text: str) -> bool:
    """Did the reply claim the task is finished?

    The claim is the first or the last non-empty line, and it is the word DONE alone or followed
    by a single number (a confidence). ``DONE with the first half`` is a status, not a finish, and
    "done thinking about it" is not a claim at all.
    """
    lines = [
        line.strip().strip(_CLAIM_STRIP).rstrip(".!").strip()
        for line in str(text or "").splitlines()
        if line.strip()
    ]
    lines = [line for line in lines if line]
    for candidate in (lines[0] if lines else "", lines[-1] if lines else ""):
        if not candidate.upper().startswith("DONE"):
            continue
        rest = candidate[4:].strip(" \t:=-()[]%,.")
        if not rest:
            return True
        tokens = rest.split()
        if len(tokens) == 1 and _NUMBER.fullmatch(tokens[0].strip("()[]%,").rstrip(".")):
            return True
    return False


@dataclass(frozen=True, slots=True)
class Goal:
    """What the agent was asked to do, injected as one system message.

    Attributes:
        objective: The task in prose.
        constraints: Rules the agent must keep.
    """

    objective: str
    constraints: tuple[str, ...] = ()

    def system_text(self) -> str:
        """The text of the system message that carries the goal."""
        objective = bounded_text(self.objective, field="goal objective", maximum=MAX_GOAL_CHARS)
        constraints = tuple(
            bounded_text(item, field="goal constraint", maximum=512) for item in self.constraints
        )
        suffix = ""
        if constraints:
            suffix = "\nConstraints:\n" + "\n".join(f"- {item}" for item in constraints)
        return (
            "You are a scoped local agent that acts only through its registered tools. Goal: "
            + objective
            + suffix
        )


@dataclass
class _Turn:
    """The mutable state of one turn, in one place so the loop reads top to bottom."""

    guard: TurnGuard
    user: AgentMessage
    projected: list[AgentMessage]
    receipts: list[dict[str, Any]] = field(default_factory=list)
    compacted: bool = False
    tool_rounds: int = 0
    retries: int = 0
    duplicates: int = 0
    malformed: int = 0
    cache: dict[str, str] = field(default_factory=dict)
    called: set[str] = field(default_factory=set)
    last_key: str = ""
    streak: int = 0
    force_final: str = ""
    note: str = ""
    verify_left: int = VERIFY_PUSHBACKS
    pushbacks: int = 0
    check_state: str = "none"
    last_pushback: dict[str, Any] | None = None
    claim_settled_as: str = ""


@dataclass
class _Round:
    """What one round of tool calls did, as the facts the kernel decision needs."""

    failed: bool = False
    duplicate: bool = False
    stagnation: bool = False
    same_result: str = "none"
    repeated_any: bool = False
    first_failure: tuple[str, str] | None = None


class LocalAgent:
    """A multi-turn local agent with explicit tools, a goal, and a bounded context.

    Args:
        ledger: The thread's append-only ledger.
        transport: Answers chat payloads. Wrapped to leave a ``model.call`` receipt when
            ``receipts`` is given.
        model: Model name sent in every payload.
        goal: Injected as a system message; it is not a second ledger.
        compactor: Bounds the projection sent to the model.
        tools: The gate. Defaults to an empty registry.
        policy: Runs ``kernel.alcor``. Defaults to the registry's policy host.
        receipts: Where model calls, decisions and turns are recorded.
        timeout: Seconds for one model call.
        turn_timeout: Seconds for the whole turn. Defaults to ``timeout``.
        stop_paths: Extra STOP files that halt the turn.
        owner_enabled: True only when the operator enabled owner-class effects. Set by the host
            from its own flag; the model cannot influence it.
        recover_tool_errors: When False, the first failed tool call fails the turn.
        max_tool_error_retries: Failed rounds tolerated before the turn is finalized.
        force_final_after_duplicate_tool: Ask for prose after an exact repeated call.
        max_tool_rounds: Tool rounds before the turn is asked to finish.
        verifier: The task's own check, called when the model claims DONE. Returns a mapping with
            ``ok``, ``rc`` and ``output``.
        max_response_tokens: Optional output cap, 1 to 4096.
        lane: Lane name recorded in model-call receipts.
    """

    def __init__(
        self,
        *,
        ledger: ThreadLedger,
        transport: ChatTransport,
        model: str,
        goal: Goal | None = None,
        compactor: ContextCompactor | None = None,
        tools: ToolRegistry | None = None,
        policy: PolicyHost | None = None,
        receipts: ReceiptLog | None = None,
        timeout: float = 120.0,
        turn_timeout: float | None = None,
        stop_paths: Sequence[Path | str] = (),
        owner_enabled: bool = False,
        recover_tool_errors: bool = False,
        max_tool_error_retries: int = 1,
        force_final_after_duplicate_tool: bool = True,
        max_tool_rounds: int = 8,
        verifier: Callable[[], Mapping[str, Any]] | None = None,
        max_response_tokens: int | None = None,
        lane: str = "",
    ) -> None:
        if max_response_tokens is not None and (
            type(max_response_tokens) is not int or not 1 <= max_response_tokens <= 4096
        ):
            raise ValueError("max_response_tokens must be an integer between 1 and 4096")
        if not 0 <= max_tool_error_retries <= 2:
            raise ValueError("max_tool_error_retries must be between 0 and 2")
        if max_tool_rounds < 1:
            raise ValueError("max_tool_rounds must be at least 1")
        self.timeout = float(timeout)
        self.turn_timeout = self.timeout if turn_timeout is None else float(turn_timeout)
        if not 0 < self.timeout < float("inf") or not 0 < self.turn_timeout < float("inf"):
            raise ValueError("agent timeouts must be positive and finite")
        self.ledger = ledger
        self.receipts = receipts
        if receipts is not None and not isinstance(transport, ReceiptingTransport):
            transport = ReceiptingTransport(transport, receipts, lane=lane)
        self.transport = transport
        self.model = bounded_text(model, field="model", maximum=256)
        self.goal = goal
        self.max_response_tokens = max_response_tokens
        self.compactor = compactor or ContextCompactor()
        self.tools = tools or ToolRegistry()
        self.policy = policy or self.tools.policy
        self.stop_paths = tuple(stop_paths)
        self.owner_enabled = owner_enabled
        self.recover_tool_errors = bool(recover_tool_errors)
        self.max_tool_error_retries = int(max_tool_error_retries)
        self.force_final_after_duplicate_tool = bool(force_final_after_duplicate_tool)
        self.max_tool_rounds = int(max_tool_rounds)
        self.verifier = verifier
        # State that outlives a turn: a stall is a property of the task, not of one turn.
        self.written: dict[Path, int] = {}  # file -> ordinal of the call that wrote it
        self.read_back: dict[Path, int] = {}  # file -> ordinal of the latest call that read it
        self._failed_twice: dict[str, tuple[str, int]] = {}
        try:
            self._call_history = prior_call_history(self.ledger.messages())
        except AgentRuntimeError:
            self._call_history = {}
        self._last_pushback: dict[str, Any] | None = None
        self._calls_total = 0
        self._turn_no = 0

    # -- verification debt ---------------------------------------------------------------------

    def unread_writes(self) -> list[str]:
        """Files the agent changed and never read back: verification owed before a claim stands.

        The read has to come *after* the write. Comparing names only accepted read, write, DONE
        with nothing owed, and a turn-one look would have discharged a turn-two change.
        """
        return sorted(
            self.tools.scope.display(path)
            for path, at in self.written.items()
            if not any(path == seen and order >= at for seen, order in self.read_back.items())
        )

    def _paths(self, name: str, arguments: Mapping[str, Any], tools: frozenset[str]) -> set[Path]:
        raw = str(arguments.get("path") or "").strip()
        if name not in tools or not raw:
            return set()
        try:
            return {self.tools.scope.resolve(raw)}
        except (OSError, ValueError):
            return set()

    # -- the kernel decision -------------------------------------------------------------------

    def _settle(
        self,
        *,
        tool_rounds: int,
        tool_error_retries: int,
        round_failed: bool = False,
        duplicate_in_round: bool = False,
        claims: bool = False,
        check_state: str = "none",
        verify_left: int = 0,
        same_result: str = "none",
        unverified_write: str = "no",
        claim_unchanged: str = "no",
        stagnation_detected: bool = False,
    ) -> dict[str, str]:
        """The end-of-round decision, made by ``kernel.alcor`` and obeyed here.

        The host computes the arithmetic into yes/no cells; the program owns the precedence
        between strict failure, tool errors, duplicates and budget. A missing or refusing policy
        raises: a turn does not continue on none.
        """

        def yes(flag: bool) -> str:
            return "yes" if flag else "no"

        cells = {
            "schema": KERNEL_REQUEST_SCHEMA,
            "effect_authority": "false",
            # The programs this turn depends on were pinned when it started; a round without
            # that pin is not permitted to continue.
            "strategy_state": "selected",
            "round_failed": yes(round_failed),
            "recover_tool_errors": yes(self.recover_tool_errors),
            "retries_exhausted": yes(tool_error_retries >= self.max_tool_error_retries),
            "duplicate_in_round": yes(duplicate_in_round),
            "stagnation_detected": yes(stagnation_detected),
            "force_final_after_duplicate": yes(self.force_final_after_duplicate_tool),
            "budget_spent": yes(tool_rounds >= self.max_tool_rounds),
            "half_spent": yes(tool_rounds >= max(1, int(self.max_tool_rounds * 0.6))),
            "claims_done": yes(claims),
            "check_state": check_state,
            "verify_left": str(int(verify_left)),
            "coach_note": "no",
            "solver_state": "none",
            # A repeated call whose result changed is a retry, not a loop.
            "same_result": same_result,
            "reread": "no",
            "children_pending": "no",
            "other_core_idle": "no",
            "unverified_write": unverified_write,
            # A claim repeated with nothing run since the last pushback cannot be improved by
            # saying it again: the note that could have helped was already delivered.
            "claim_unchanged": claim_unchanged,
        }
        try:
            decision = self.policy.decide(KERNEL_PROGRAM, cells, KERNEL_DECISION_SCHEMA)
        except PolicyError as exc:
            raise AgentRuntimeError("kernel-policy-unavailable", exc.code) from exc
        if decision.get("action") not in ("continue", "finalize", "fail", "accept", "pushback"):
            raise AgentRuntimeError("kernel-policy-refused-the-round", decision.get("reason"))
        return dict(decision.fields)

    # -- the turn ------------------------------------------------------------------------------

    def turn(self, user_text: str) -> dict[str, Any]:
        """Run one user message to a final answer, or to a typed failure.

        Returns:
            An ``alcor.cli.agent-result.v1`` mapping. ``ok`` is True when a final answer was
            committed; otherwise ``failure_class`` says why (``agent-owner-stop``, a tool failure
            under strict mode, an uncertain commit).
        """
        guard: TurnGuard | None = None
        try:
            guard = TurnGuard(self.turn_timeout, self.stop_paths, self._pins())
            guard.boundary()
            result = self._run_turn(user_text, guard)
        except CompletionPersistenceUncertain as exc:
            result = {
                "schema": RESULT_SCHEMA,
                "ok": False,
                "thread_id": self.ledger.thread_id,
                **exc.as_result(),
                "tool_calls": list(guard.receipts) if guard else [],
            }
        except TurnInterrupted as exc:
            result = self._interrupted(exc, guard)
        return self._receipt_turn(result)

    def _pins(self) -> dict[Path, str]:
        """Pin the bytes of the programs this turn depends on, so an edit mid-turn stops it."""
        try:
            programs = [self.policy.find_program(name) for name in (KERNEL_PROGRAM, "tool")]
            return {path: TurnGuard.pin(path) for path in programs}
        except (PolicyError, OSError) as exc:
            raise AgentRuntimeError("round-policy-unavailable", str(exc)[:80]) from exc

    def _interrupted(self, exc: TurnInterrupted, guard: TurnGuard | None) -> dict[str, Any]:
        """Close only this turn's outstanding tool envelope and report the stop.

        A proposal that never ran is distinct from a handler interrupted before its outcome was
        known, and the ledger records which.
        """
        receipts: list[dict[str, Any]] = list(guard.receipts) if guard else []
        if guard is not None:
            for call_id, name in guard.pending.items():
                status = "outcome_unknown" if guard.executing == call_id else "not_executed"
                outcome = {"ok": False, "status": status, "error": exc.code}
                self.ledger.append_message(
                    "tool",
                    json.dumps(outcome, separators=(",", ":")),
                    name=name,
                    tool_call_id=call_id,
                )
                receipts.append({"name": name, "tool_call_id": call_id, **outcome})
        return {
            "schema": RESULT_SCHEMA,
            "ok": False,
            "failure_class": exc.code,
            "error": "agent turn interrupted",
            "thread_id": self.ledger.thread_id,
            "tool_calls": receipts,
            "history_messages": len(self.ledger.messages()),
        }

    def _receipt_turn(self, result: dict[str, Any]) -> dict[str, Any]:
        """Record the turn as hashes and counts. The reply text itself never enters a receipt."""
        if self.receipts is None:
            return result
        try:
            row = self.receipts.append(
                "agent.turn",
                {
                    "thread_id": self.ledger.thread_id,
                    "ok": bool(result.get("ok")),
                    "failure_class": result.get("failure_class"),
                    "reply_sha256": sha256_hex(result["reply"]) if result.get("reply") else None,
                    "tool_rounds": result.get("tool_rounds", 0),
                    "tool_calls": len(result.get("tool_calls", [])),
                    "verify_pushbacks": result.get("verify_pushbacks", 0),
                    "ended_because": result.get("ended_because"),
                },
            )
            result["turn_receipt_id"] = row["id"]
        except ReceiptError:
            result["turn_receipt_id"] = ""
        return result

    def _history(self) -> list[AgentMessage]:
        messages = self.ledger.messages()
        if self.goal:
            text = self.goal.system_text()
            if not any(m.role == "system" and m.content == text for m in messages):
                messages.insert(
                    0, AgentMessage("system", text, "goal-" + sha256_hex(text)[:16], 0.0)
                )
        return messages

    def _reproject(self, turn: _Turn) -> None:
        """Rebuild the bounded projection and record a compaction if it dropped anything."""
        turn.projected, compaction = self.compactor.compact(self._history())
        if compaction:
            self.ledger.append_compaction(
                dropped_count=compaction["dropped_count"],
                source_digest=compaction["source_digest"],
                summary=compaction["summary"],
                truncated=compaction["truncated"],
                projection=compaction["projection"],
            )
            turn.compacted = True

    def _run_turn(self, user_text: str, guard: TurnGuard) -> dict[str, Any]:
        self._turn_no += 1
        user = self.ledger.append_message("user", bounded_text(user_text, field="user text"))
        turn = _Turn(guard=guard, user=user, projected=[])
        guard.receipts = turn.receipts
        self._reproject(turn)
        while True:
            guard.check()
            payload = self._payload(turn)
            guard.boundary()
            try:
                response = self.transport.complete(
                    payload,
                    timeout=min(self.timeout, guard.check()),
                    deadline=guard.deadline,
                    guard=guard.check,
                )
            except Exception:
                guard.check()  # Classify STOP or deadline even if the socket raised first.
                raise
            guard.boundary()
            message = completion_message(response, require_finish=False)
            content = (message.get("content") or "").strip()
            calls = list(message.get("tool_calls") or [])
            try:
                normalised = tuple(normalise_tool_call(c, require_id=False) for c in calls)
            except AgentRuntimeError as exc:
                self._malformed(turn, exc)
                continue
            claimed = not calls and claims_done(content) and self._owes_check()
            if claimed and self._settle_claim(turn, content):
                continue
            if not calls:
                return self._finish(
                    turn, content or "(empty model response)", turn.force_final or "model_finished"
                )
            if turn.force_final:
                # It was asked for prose and answered with another tool call. Keep the prose.
                return self._finish(
                    turn,
                    content or "(no answer was given before the tool budget ended)",
                    turn.force_final,
                    answered_after_finalization=not bool(content),
                )
            if turn.tool_rounds >= self.max_tool_rounds:
                turn.force_final = "budget"
                continue
            turn.tool_rounds += 1
            # Persist the assistant envelope before any tool result; replay and the OpenAI tool
            # protocol both depend on that order.
            guard.check()
            self.ledger.append_message("assistant", content, tool_calls=normalised)
            guard.pending = {str(c["id"]): str(c["function"]["name"]) for c in normalised}
            outcome = self._run_round(turn, normalised)
            guard.check()
            verdict = self._settle(
                tool_rounds=turn.tool_rounds,
                tool_error_retries=turn.retries,
                round_failed=outcome.failed,
                duplicate_in_round=outcome.duplicate,
                same_result="yes"
                if (outcome.repeated_any and outcome.same_result == "none")
                else outcome.same_result,
                stagnation_detected=outcome.stagnation,
            )
            if outcome.failed and verdict["action"] == "continue":
                turn.note = self._tool_correction((outcome.first_failure or ("", ""))[1])
            if verdict["action"] == "fail":
                return self._strict_failure(turn, outcome)
            if verdict["action"] == "finalize" and verdict["reason"] == "tool_errors":
                turn.force_final = "tool_errors"
            else:
                turn.retries = turn.retries + 1 if outcome.failed else 0
                if verdict["action"] == "finalize" and verdict["reason"] in (
                    "duplicate",
                    "budget",
                    "stagnation",
                ):
                    turn.force_final = verdict["reason"]
            self._reproject(turn)

    def _payload(self, turn: _Turn) -> dict[str, Any]:
        """Build the request for the next model call from the bounded projection."""
        payload: dict[str, Any] = {
            "model": self.model,
            "stream": False,
            "messages": [item.as_api() for item in turn.projected],
        }
        if self.max_response_tokens is not None:
            payload["max_tokens"] = self.max_response_tokens
        if turn.force_final:
            payload["messages"].append(
                {"role": "system", "content": FINAL_INSTRUCTION[turn.force_final]}
            )
            # No schemas for the final answer, so a tool envelope cannot be mistaken for a reply.
            payload["tool_choice"] = "none"
            return payload
        schemas = self.tools.schemas()
        if not schemas:
            return payload
        payload["tools"] = schemas
        payload["tool_choice"] = "auto"
        # Tell the model what it is spending. A budget that never reaches the model gives it
        # nothing to condition stopping on. The note is task-neutral on purpose.
        note = f"Tool round {turn.tool_rounds} of {self.max_tool_rounds}."
        if turn.tool_rounds >= max(1, int(self.max_tool_rounds * 0.6)):
            note += (
                " More than half of the budget is spent. If you are still gathering, produce what "
                "was asked for now, or say plainly what you could not determine."
            )
        messages = payload["messages"]
        if turn.note:
            messages.append({"role": "system", "content": turn.note})
            turn.note = ""
        if messages and messages[0].get("role") == "system":
            messages[0] = {**messages[0], "content": f"{messages[0]['content']}\n\n{note}"}
        else:
            messages.insert(0, {"role": "system", "content": note})
        return payload

    def _malformed(self, turn: _Turn, exc: AgentRuntimeError) -> None:
        """A tool call written badly is the model's to fix, not a reason to end the turn."""
        # Nothing is written with tool_calls: a half-normalised envelope would leave ids that no
        # result answers and make the thread invalid on replay. The complaint rides in the next
        # payload instead.
        self.ledger.append_message("assistant", "(a malformed tool call)")
        turn.note = (
            f"That tool call could not be read: {exc.code}. Reissue it correctly, or answer in "
            "plain prose if you no longer need a tool. If an argument was too long, do the work "
            "in smaller pieces rather than one large call."
        )
        turn.malformed += 1
        if turn.retries >= self.max_tool_error_retries:
            turn.force_final = "tool_errors"
        turn.retries += 1

    def _owes_check(self) -> bool:
        return self.verifier is not None or bool(self.unread_writes())

    def _settle_claim(self, turn: _Turn, content: str) -> bool:
        """Check a claim of DONE. Returns True when it was pushed back and the loop must go on."""
        guard = turn.guard
        reading: Mapping[str, Any] = {}
        if self.verifier is not None:
            try:
                guard.check()
                reading = self.verifier() or {}
            except TurnInterrupted:
                raise
            except Exception as exc:
                reading = {"ok": False, "error": str(exc)[:160]}
            guard.check()
        if self.verifier is None:
            state = "unavailable"
        elif reading.get("ok"):
            state = "green"
        else:
            state = "unavailable" if reading.get("rc") is None else "red"
        unchanged = (
            bool(self._last_pushback) and self._last_pushback["at_calls"] == self._calls_total
        )
        verdict = self._settle(
            tool_rounds=turn.tool_rounds,
            tool_error_retries=turn.retries,
            claims=True,
            check_state=state,
            verify_left=turn.verify_left,
            unverified_write="yes" if self.unread_writes() else "no",
            claim_unchanged="yes" if unchanged else "no",
        )
        if verdict["action"] == "accept":
            turn.claim_settled_as = (
                "repeat_claim_nothing_changed"
                if verdict.get("reason") == "repeat-claim-nothing-changed"
                else str(verdict.get("reason") or "accepted")
            )
        if verdict["action"] != "pushback":
            turn.check_state = state
            return False
        turn.verify_left -= 1
        turn.pushbacks += 1
        self.ledger.append_message("assistant", content)
        # The correction has to name the thing to fix, and the reason comes from the verdict, not
        # from which branch happened to run last.
        if verdict.get("reason") == "unverified_write":
            turn.note = (
                f"You changed {', '.join(self.unread_writes()[:3])} and never read it back. Read "
                "it and say what it now contains, then answer again: a claim over an unread write "
                "is how most tasks fail."
            )
        else:
            printed = str(reading.get("output") or reading.get("error") or "")[-400:]
            turn.note = (
                "You said DONE, but the task's check still fails. It ran just now and printed: "
                f"{printed}. Look at what it measures, fix the cause or say plainly what you could "
                "not do. Do not say DONE while it fails."
            )
        # Remembered across turns: the next claim with nothing run in between is accepted.
        self._last_pushback = {
            "reason": str(verdict.get("reason") or "pushback"),
            "note": turn.note,
            "at_calls": self._calls_total,
            "turn": self._turn_no,
        }
        turn.last_pushback = dict(self._last_pushback)
        self._reproject(turn)
        return True

    def _finish(self, turn: _Turn, reply: str, ended_because: str, **extra: Any) -> dict[str, Any]:
        """Commit the final answer in two steps and build the success result."""
        turn.guard.boundary()
        assistant = self.ledger.append_completion(
            reply, user_message_id=turn.user.message_id, guard=turn.guard.boundary
        )
        return {
            "schema": RESULT_SCHEMA,
            "ok": True,
            "thread_id": self.ledger.thread_id,
            "message_id": assistant.message_id,
            "reply": assistant.content,
            "tool_calls": turn.receipts,
            "compacted": turn.compacted,
            "history_messages": len(self.ledger.messages()),
            "request_user_message_id": turn.user.message_id,
            "tool_error_recovery_attempts": turn.retries,
            "duplicate_tool_calls": turn.duplicates,
            "malformed_tool_calls": turn.malformed,
            "verify_pushbacks": turn.pushbacks,
            "check_state_at_claim": turn.check_state,
            "ended_because": ended_because,
            "tool_rounds": turn.tool_rounds,
            "strategy_state": "selected",
            "last_pushback": turn.last_pushback,
            "claim_settled_as": turn.claim_settled_as,
            **extra,
        }

    def _strict_failure(self, turn: _Turn, outcome: _Round) -> dict[str, Any]:
        """Strict mode: an agent told not to recover from tool errors fails hard and loudly."""
        failure_class, error = outcome.first_failure or ("tool_failed", "tool call failed")
        return {
            "schema": RESULT_SCHEMA,
            "ok": False,
            "failure_class": failure_class,
            "error": error,
            "thread_id": self.ledger.thread_id,
            "tool_calls": turn.receipts,
            "compacted": turn.compacted,
            "history_messages": len(self.ledger.messages()),
            "request_user_message_id": turn.user.message_id,
            "tool_error_recovery_attempts": turn.retries,
            "duplicate_tool_calls": turn.duplicates,
            "tool_rounds": turn.tool_rounds,
        }

    # -- one round of tool calls ---------------------------------------------------------------

    def _tool_message(
        self, turn: _Turn, name: str, call_id: str, text: str, receipt: Mapping[str, Any]
    ) -> None:
        """Append a tool result to the ledger and close its slot in the pending envelope."""
        self.ledger.append_message("tool", text, name=name, tool_call_id=call_id)
        turn.guard.pending.pop(call_id, None)
        turn.guard.executing = None
        turn.receipts.append({"name": name, "tool_call_id": call_id, **receipt})

    def _run_round(self, turn: _Turn, calls: Sequence[Mapping[str, Any]]) -> _Round:
        outcome = _Round()
        guard = turn.guard
        for call in calls:
            guard.check()
            name = str(call["function"]["name"])
            arguments = json.loads(str(call["function"]["arguments"]))
            call_id = str(call["id"])
            cache_key = name + "\n" + str(call["function"]["arguments"])
            repeated_call = cache_key in turn.called
            turn.called.add(cache_key)
            if cache_key == turn.last_key:
                turn.streak += 1
            else:
                turn.last_key, turn.streak = cache_key, 1
            outcome.stagnation = outcome.stagnation or turn.streak >= STAGNATION_STREAK
            self._calls_total += 1
            # Telling the model is not stopping it. Only when the SAME call has already failed
            # twice with the SAME result is a third attempt refused, because that is the one case
            # where it cannot teach anyone anything. A call that starts succeeding, or fails
            # differently, is never touched.
            prior = self._failed_twice.get(cache_key)
            if prior is not None and prior[1] >= 2:
                refusal = json.dumps(
                    {
                        "ok": False,
                        "status": "refused",
                        "outcome": "refused",
                        "error": "this exact call has already failed twice with the same result, "
                        "so it will fail the same way again",
                        "last_result": str(prior[0])[:300],
                        "do": "change something before you run it: a different command, a "
                        "different tool, or a smaller piece of it run on its own.",
                    },
                    separators=(",", ":"),
                )
                self._tool_message(
                    turn,
                    name,
                    call_id,
                    refusal,
                    {"ok": False, "error": "refused: identical call failed twice"},
                )
                continue
            repeated = cache_key in turn.cache
            outcome.repeated_any = outcome.repeated_any or repeated
            if self.force_final_after_duplicate_tool and repeated:
                turn.duplicates += 1
                outcome.duplicate = True
            if (
                self.force_final_after_duplicate_tool
                and repeated
                and not self.tools.is_mutating(name)
            ):
                result, cached = turn.cache[cache_key], True
            else:
                cached = False
                result = self._invoke(turn, outcome, name, arguments, call_id)
                if result is None:
                    continue
                turn.cache[cache_key] = result
                self._note_failure(cache_key, result)
                # A remembered result is a claim about the world, and it is void once the world
                # changes. So are failure signatures, or a repair could never be observed.
                if self.tools.is_mutating(name):
                    turn.cache.clear()
                    if not self._failure_signature(result)[0]:
                        self._failed_twice.clear()
                # A mutating tool is always executed again and its first receipt is never reused.
                # Once that execution shows the exact call returned the exact same answer, though,
                # the kernel should require a reassessment, as it does for a cached read.
                note = repeat_note(self._call_history, cache_key, result)
                if note is not None:
                    outcome.same_result = "yes" if note["same_result"] else "no"
                    if (
                        self.force_final_after_duplicate_tool
                        and repeated_call
                        and note["same_result"]
                        and not outcome.duplicate
                    ):
                        turn.duplicates += 1
                        outcome.duplicate = True
                result = with_repeat_note(result, note)
            failed, error = self._result_failed(result)
            receipt: dict[str, Any] = {"ok": not failed}
            if cached:
                receipt["cached"] = True
            if failed:
                receipt["error"] = error
                outcome.failed = True
                outcome.first_failure = outcome.first_failure or ("tool_failed", error)
            else:
                # Only a call that happened can owe, or discharge, a read-back. A refused write
                # changed nothing, so it must not leave the agent owing a look at an unchanged file.
                for path in self._paths(name, arguments, WRITE_TOOLS):
                    self.written[path] = self._calls_total
                for path in self._paths(name, arguments, READ_BACK_TOOLS):
                    self.read_back[path] = self._calls_total
            self._tool_message(turn, name, call_id, result, receipt)
            guard.check()
        return outcome

    def _invoke(
        self, turn: _Turn, outcome: _Round, name: str, arguments: Mapping[str, Any], call_id: str
    ) -> str | None:
        """Run one admitted call. Returns its result text, or None when it was refused or failed."""
        guard = turn.guard
        guard.boundary()
        guard.executing = call_id
        try:
            return self.tools.invoke(
                name, arguments, owner_enabled=self.owner_enabled, guard=guard.boundary
            )
        except TurnInterrupted:
            raise
        except ToolDenied as exc:
            message = str(exc)
            text = json.dumps(
                {
                    "ok": False,
                    "status": "refused",
                    "verdict": exc.verdict,
                    "reason": exc.reason,
                    "error": message,
                },
                separators=(",", ":"),
            )
            receipt = {"ok": False, "refused": True, "verdict": exc.verdict, "reason": exc.reason}
        except AgentRuntimeError as exc:
            message = str(exc)
            text = json.dumps({"ok": False, "error": message}, separators=(",", ":"))
            receipt = {"ok": False, "error": message}
        self._tool_message(turn, name, call_id, text, receipt)
        outcome.failed = True
        outcome.first_failure = outcome.first_failure or ("tool_denied_or_invalid", message)
        return None

    def _note_failure(self, cache_key: str, result: str) -> None:
        """Count identical failures so the third attempt at the same failing call is refused."""
        failed, signature = self._failure_signature(result)
        if not failed:
            self._failed_twice.pop(cache_key, None)
            return
        seen = self._failed_twice.get(cache_key)
        self._failed_twice[cache_key] = (
            (signature, seen[1] + 1) if seen and seen[0] == signature else (signature, 1)
        )

    @staticmethod
    def _tool_correction(error: str) -> str:
        """Turn a tool error into bounded, actionable retry guidance."""
        lowered = str(error).lower()
        if "outside the allowed roots" in lowered or "leaves-the-allowed-roots" in lowered:
            return "Use a path inside the workspace; the gate refuses anything outside it."
        if "not found" in lowered or "filenotfounderror" in lowered or "not-a-file" in lowered:
            return (
                "Verify the path with list_dir or search_repo, then retry with the discovered path."
            )
        if "argument" in lowered or "required" in lowered:
            return "Correct the tool arguments from its schema before retrying."
        return "Change the failed call using its typed receipt; do not repeat identical arguments."

    @staticmethod
    def _failure_signature(result: str) -> tuple[bool, str]:
        try:
            parsed = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return False, ""
        if isinstance(parsed, dict) and parsed.get("ok") is False:
            signature = parsed.get("stderr") or parsed.get("error") or parsed.get("status") or ""
            return True, str(signature)[:200]
        return False, ""

    @staticmethod
    def _result_failed(result: str) -> tuple[bool, str]:
        """A correct "no" is not a failed round: ``answered_no`` is a successful answer."""
        try:
            parsed = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return False, ""
        if (
            isinstance(parsed, dict)
            and parsed.get("ok") is False
            and parsed.get("outcome") != "answered_no"
        ):
            return True, str(parsed.get("error") or "tool failed")
        return False, ""
