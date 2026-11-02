"""Bounded low-latency subtask executor: a fast policy acts, an independent verifier decides.

A planner hands the executor a ``Subtask`` (goal, literal inputs, constraints, verification
criteria, action budget). A fast ``DecisionPolicy`` then picks steps from a legal action space
derived from the current observation. The design ideas come from the MIT-licensed
``shhivv/arc-cua`` project (see NOTICE.md); no code from it is included.

* The planner owns intent, literal text and criteria. The policy cannot supply text or
  coordinates: typed content comes only from ``Subtask.inputs`` and click points only from
  perception-backed ``DesktopElement`` records.
* Every effect goes through ``AppControllerElementBackend`` and from there through the existing
  ``AppController`` grant and receipt path. This module adds no actuator and no permission source.
* Stale observations are discarded and re-decided, never replayed. UI settling, no-change
  detection and action budgets belong to the runtime, not the policy.
* The policy may only *propose* completion. A separate ``CompletionVerifier`` must confirm it from
  a fresh observation before the result counts as ``SUBTASK_COMPLETE``.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

SCHEMA = "alcor.computer.reflex-executor.v1"
MAX_SUBTASK_ACTIONS = 25
# The third CONTINUE verdict in one episode escalates to the planner instead of looping forever.
MAX_VERIFICATION_CONTINUES = 3
MAX_LITERAL_CHARS = 1024
MAX_PUBLIC_RATIONALE_CHARS = 280


class ReflexError(ValueError):
    """A refusal in the reflex layer with a bounded reason code.

    Attributes:
        reason_code: Short snake_case code such as ``unknown_input_key``.
    """

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


class ActionKind(str, Enum):
    """The operations a policy can choose. ``TYPE_TEXT`` binds an input key, never text."""

    CLICK = "CLICK"
    TYPE_TEXT = "TYPE_TEXT"
    PRESS_KEY = "PRESS_KEY"
    FOCUS = "FOCUS"


class TerminalKind(str, Enum):
    """How an episode ends: proposed complete, blocked, or handed back to the planner."""

    SUBTASK_COMPLETE = "SUBTASK_COMPLETE"
    BLOCKED = "BLOCKED"
    NEEDS_AGENT = "NEEDS_AGENT"


class VerificationKind(str, Enum):
    """The only three verdicts a completion verifier may return."""

    VERIFIED_COMPLETE = "VERIFIED_COMPLETE"
    CONTINUE = "CONTINUE"
    ESCALATE = "ESCALATE"


@dataclass(frozen=True, slots=True)
class VerificationDecision:
    """A verifier's verdict.

    Attributes:
        kind: ``VERIFIED_COMPLETE``, ``CONTINUE`` or ``ESCALATE``.
        evidence: Statements supporting the verdict; at least one is required to verify.
        reason: Optional short explanation, used when escalating.
    """

    kind: VerificationKind
    evidence: tuple[str, ...] = ()
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, VerificationKind):
            raise ReflexError("verification_kind_invalid")
        if not isinstance(self.evidence, tuple) or any(
            not isinstance(item, str) or not item.strip() for item in self.evidence
        ):
            raise ReflexError("verification_evidence_invalid")
        if self.kind == VerificationKind.VERIFIED_COMPLETE and not self.evidence:
            raise ReflexError("verified_complete_requires_evidence")
        if self.reason is not None and (
            not isinstance(self.reason, str) or not self.reason.strip()
        ):
            raise ReflexError("verification_reason_invalid")


DEFAULT_PRESS_KEYS: tuple[str, ...] = (
    "ENTER",
    "ESCAPE",
    "TAB",
    "SPACE",
    "BACKSPACE",
    "DELETE",
    "ARROW_UP",
    "ARROW_DOWN",
    "ARROW_LEFT",
    "ARROW_RIGHT",
)


@dataclass(frozen=True, slots=True)
class Subtask:
    """One bounded unit of work handed down by the planner.

    Attributes:
        goal: What to achieve, in plain words.
        verification: Criteria an independent verifier checks. At least one.
        inputs: Literal strings the policy may type, by key. Policies never see values.
        constraints: Rules the policy must respect.
        max_actions: Action budget, 1 to ``MAX_SUBTASK_ACTIONS``.
    """

    goal: str
    verification: tuple[str, ...]
    inputs: Mapping[str, str] = field(default_factory=dict)
    constraints: tuple[str, ...] = ()
    max_actions: int = 15

    def __post_init__(self) -> None:
        if not isinstance(self.goal, str) or not self.goal.strip():
            raise ReflexError("subtask_goal_invalid")
        if (
            not isinstance(self.verification, tuple)
            or not self.verification
            or any(not isinstance(item, str) or not item.strip() for item in self.verification)
        ):
            raise ReflexError("subtask_verification_invalid")
        if not isinstance(self.constraints, tuple) or any(
            not isinstance(item, str) or not item.strip() for item in self.constraints
        ):
            raise ReflexError("subtask_constraints_invalid")
        if type(self.max_actions) is not int or not 1 <= self.max_actions <= MAX_SUBTASK_ACTIONS:
            raise ReflexError("subtask_action_budget_invalid")
        if not isinstance(self.inputs, Mapping):
            raise ReflexError("subtask_inputs_invalid")
        for key, value in self.inputs.items():
            if not isinstance(key, str) or not key.strip():
                raise ReflexError("subtask_input_key_invalid")
            if not isinstance(value, str) or len(value) > MAX_LITERAL_CHARS or "\x00" in value:
                raise ReflexError("subtask_input_value_invalid")


@dataclass(frozen=True, slots=True)
class DesktopElement:
    """One perception-owned UI target.

    screen_point is an absolute host-screen point produced by trusted perception.
    The policy sees the element id and legal actions; it does not provide coordinates.
    """

    id: str
    role: str
    name: str
    actions: tuple[ActionKind, ...]
    screen_point: tuple[int, int] | None = None
    value: str | None = None
    visible: bool = True
    enabled: bool = True
    focused: bool = False
    source: str = "unknown"

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not self.id.strip() or len(self.id) > 128:
            raise ReflexError("element_id_invalid")
        if not isinstance(self.role, str) or not isinstance(self.name, str):
            raise ReflexError("element_text_invalid")
        if (
            not isinstance(self.actions, tuple)
            or any(
                action not in {ActionKind.CLICK, ActionKind.TYPE_TEXT} for action in self.actions
            )
            or len(set(self.actions)) != len(self.actions)
        ):
            raise ReflexError("element_actions_invalid")
        if self.screen_point is not None and (
            not isinstance(self.screen_point, tuple)
            or len(self.screen_point) != 2
            or any(type(value) is not int for value in self.screen_point)
        ):
            raise ReflexError("element_screen_point_invalid")

    def signature(self) -> tuple[Any, ...]:
        """Return a tuple of every observable field, including geometry, for change detection."""
        return (
            self.id,
            self.role,
            self.name,
            self.value,
            self.visible,
            self.enabled,
            self.focused,
            self.source,
            tuple(action.value for action in self.actions),
            self.screen_point,
        )

    def semantic_guard(self) -> str:
        """Stable semantic identity used for immediate pre-effect revalidation.

        Geometry is intentionally excluded: perception may move the same control
        between policy selection and execution, in which case the backend uses the
        freshly observed point. Semantic/state changes force a new policy decision.
        """
        payload = {
            "id": self.id,
            "role": self.role,
            "name": self.name,
            "value": self.value,
            "visible": self.visible,
            "enabled": self.enabled,
            "focused": self.focused,
            "source": self.source,
            "actions": [action.value for action in self.actions],
        }
        return hashlib.sha256(
            json.dumps(
                payload,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
                default=str,
            ).encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True, slots=True)
class DesktopSnapshot:
    """One perception result.

    Attributes:
        observation_id: Id of the controller observation behind it.
        revision: Hash of the target and all elements; changes when anything observable does.
        elements: The perceived elements, with unique ids.
        context: Binding facts about the target (title, bounds), used to detect a switch.
    """

    observation_id: str
    revision: str
    elements: tuple[DesktopElement, ...]
    context: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.observation_id, str) or not self.observation_id:
            raise ReflexError("snapshot_observation_id_invalid")
        if not isinstance(self.revision, str) or not self.revision:
            raise ReflexError("snapshot_revision_invalid")
        if not isinstance(self.elements, tuple):
            raise ReflexError("snapshot_elements_invalid")
        ids = [element.id for element in self.elements]
        if len(ids) != len(set(ids)):
            raise ReflexError("snapshot_duplicate_element_id")

    def element(self, element_id: str) -> DesktopElement:
        """Return the element with this id.

        Raises:
            ReflexError: ``unknown_target_id``.
        """
        for element in self.elements:
            if element.id == element_id:
                return element
        raise ReflexError("unknown_target_id")


@dataclass(frozen=True, slots=True)
class Decision:
    """A policy's choice: exactly one of an action or a terminal outcome.

    Attributes:
        kind: The operation, for an action.
        terminal: The outcome, for a stop.
        target_id: Element id to act on (click, type).
        input_key: Key into ``Subtask.inputs`` naming the text to type.
        key: Key name to press, from the legal press keys.
        public_rationale: Short, model-visible reason; not private reasoning.
    """

    kind: ActionKind | None = None
    terminal: TerminalKind | None = None
    target_id: str | None = None
    input_key: str | None = None
    key: str | None = None
    public_rationale: str = "bounded reflex action"

    def __post_init__(self) -> None:
        if (self.kind is None) == (self.terminal is None):
            raise ReflexError("decision_must_be_action_or_terminal")
        if not isinstance(self.public_rationale, str) or "\x00" in self.public_rationale:
            raise ReflexError("decision_rationale_invalid")
        cleaned = " ".join(self.public_rationale.split())
        if not 1 <= len(cleaned) <= MAX_PUBLIC_RATIONALE_CHARS:
            raise ReflexError("decision_rationale_invalid")


@dataclass(frozen=True, slots=True)
class ExecutableAction:
    """A decision after materialisation, ready to execute.

    Coordinates now come from perception and literal text from the planner, never from the policy.
    """

    kind: ActionKind
    target_id: str | None = None
    x: int | None = None
    y: int | None = None
    text: str | None = None
    key: str | None = None


@dataclass(frozen=True, slots=True)
class ActionRecord:
    """One executed step.

    Attributes:
        step: 1-based position in the episode.
        action: What was executed.
        before_revision: Snapshot revision before the effect.
        after_revision: Revision after the UI settled.
        state_changed: Whether the revision differs.
        receipt: The backend's receipt.
    """

    step: int
    action: ExecutableAction
    before_revision: str
    after_revision: str
    state_changed: bool
    receipt: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class ExecutionResult:
    """How an episode ended.

    Attributes:
        status: The terminal outcome.
        subtask: The subtask that ran.
        final_snapshot: The last observation.
        history: Every executed step.
        reason: Why it stopped, when not complete.
        evidence_epoch: 1 only when an independent verifier confirmed completion, else 0.
        verification: The verifier's verdict, if one was asked.
        verification_continues: How many CONTINUE verdicts were used.
    """

    status: TerminalKind
    subtask: Subtask
    final_snapshot: DesktopSnapshot
    history: tuple[ActionRecord, ...]
    reason: str | None = None
    evidence_epoch: int = 0
    verification: VerificationDecision | None = None
    verification_continues: int = 0

    @property
    def actions_taken(self) -> int:
        """Return how many actions were executed."""
        return len(self.history)


class DecisionPolicy(Protocol):
    """Chooses the next step. It is a selection head, not an authority source.

    A policy may pick only among the legal operations, element ids and input keys it is shown.
    It cannot arm the runtime, choose another application, invent coordinates or invent text.
    """

    def decide(
        self,
        *,
        subtask: Subtask,
        snapshot: DesktopSnapshot,
        history: Sequence[ActionRecord],
        legal_actions: Mapping[str, Any],
    ) -> Decision:
        """Return one legal action or one terminal outcome for the current observation."""
        ...


class CompletionVerifier(Protocol):
    """Independent completion authority for a reflex episode.

    The actor may propose SUBTASK_COMPLETE, but only this verifier can turn that
    proposal into a completed result. Verification must use a fresh observation.
    """

    def verify(
        self,
        *,
        subtask: Subtask,
        snapshot: DesktopSnapshot,
        history: Sequence[ActionRecord],
    ) -> VerificationDecision:
        """Judge the subtask's verification criteria against a fresh observation."""
        ...


class ReflexBackend(Protocol):
    """What the executor needs from an environment: look, then act on what it saw."""

    def observe(self) -> DesktopSnapshot:
        """Return a fresh snapshot of the environment."""
        ...

    def execute(
        self,
        snapshot: DesktopSnapshot,
        action: ExecutableAction,
        *,
        public_rationale: str,
    ) -> Mapping[str, Any]:
        """Perform ``action`` against the state described by ``snapshot``.

        Returns:
            A receipt mapping. ``ok`` False with a stale-style ``reason_code`` makes the executor
            re-observe and ask the policy again; it never replays the action.
        """
        ...


@dataclass(frozen=True, slots=True)
class ExecutorConfig:
    """Runtime knobs for retries, stall detection and UI settling.

    Attributes:
        stale_retries: Re-observations allowed after a stale refusal.
        no_change_limit: Consecutive no-change actions before ``BLOCKED``.
        settle_min_ms: Minimum wait after an effect before accepting a stable UI.
        type_settle_min_ms: The same, after typing.
        settle_timeout_ms: Upper bound on settling.
        settle_poll_ms: Observation interval while settling.
    """

    stale_retries: int = 4
    no_change_limit: int = 3
    settle_min_ms: int = 120
    type_settle_min_ms: int = 450
    settle_timeout_ms: int = 1_500
    settle_poll_ms: int = 80

    def __post_init__(self) -> None:
        if type(self.stale_retries) is not int or not 0 <= self.stale_retries <= 20:
            raise ReflexError("stale_retry_config_invalid")
        if type(self.no_change_limit) is not int or not 1 <= self.no_change_limit <= 10:
            raise ReflexError("no_change_config_invalid")
        values = (
            self.settle_min_ms,
            self.type_settle_min_ms,
            self.settle_timeout_ms,
            self.settle_poll_ms,
        )
        if any(type(value) is not int or value < 0 for value in values):
            raise ReflexError("settle_config_invalid")
        if (
            self.settle_poll_ms < 1
            or self.settle_timeout_ms < self.settle_min_ms
            or self.settle_timeout_ms < self.type_settle_min_ms
        ):
            raise ReflexError("settle_config_invalid")


def legal_action_space(
    snapshot: DesktopSnapshot,
    subtask: Subtask,
    *,
    press_keys: Sequence[str] = DEFAULT_PRESS_KEYS,
) -> dict[str, Any]:
    """Return only operations that can be materialized from the current observation."""
    click_targets = [
        element.id
        for element in snapshot.elements
        if element.visible
        and element.enabled
        and ActionKind.CLICK in element.actions
        and element.screen_point is not None
    ]
    type_targets = [
        element.id
        for element in snapshot.elements
        if element.visible
        and element.enabled
        and element.focused
        and ActionKind.TYPE_TEXT in element.actions
    ]
    operations = [ActionKind.FOCUS.value, ActionKind.PRESS_KEY.value]
    if click_targets:
        operations.append(ActionKind.CLICK.value)
    if type_targets and subtask.inputs:
        operations.append(ActionKind.TYPE_TEXT.value)
    return {
        "schema": "alcor.computer.legal-action-space.v1",
        "operations": operations,
        "click_targets": click_targets,
        "type_targets": type_targets,
        "input_keys": sorted(subtask.inputs),
        "press_keys": [str(key).upper() for key in press_keys],
        "terminal": [terminal.value for terminal in TerminalKind],
    }


def materialize_action(
    decision: Decision,
    snapshot: DesktopSnapshot,
    subtask: Subtask,
    *,
    press_keys: Sequence[str] = DEFAULT_PRESS_KEYS,
) -> ExecutableAction:
    """Validate a policy decision and bind it to perception/planner-owned data."""
    if decision.kind is None:
        raise ReflexError("terminal_decision_not_executable")
    kind = decision.kind
    if kind == ActionKind.FOCUS:
        if any(
            value is not None for value in (decision.target_id, decision.input_key, decision.key)
        ):
            raise ReflexError("focus_fields_invalid")
        return ExecutableAction(kind=kind)
    if kind == ActionKind.PRESS_KEY:
        if decision.target_id is not None or decision.input_key is not None:
            raise ReflexError("press_key_fields_invalid")
        key = str(decision.key or "").upper()
        if key not in {str(item).upper() for item in press_keys}:
            raise ReflexError("press_key_not_legal")
        return ExecutableAction(kind=kind, key=key)

    if not decision.target_id:
        raise ReflexError("target_id_required")
    target = snapshot.element(decision.target_id)
    if not target.visible or not target.enabled:
        raise ReflexError("target_not_actionable")
    if kind not in target.actions:
        raise ReflexError("action_not_legal_for_target")

    if kind == ActionKind.CLICK:
        if decision.input_key is not None or decision.key is not None:
            raise ReflexError("click_fields_invalid")
        if target.screen_point is None:
            raise ReflexError("target_point_missing")
        return ExecutableAction(
            kind=kind,
            target_id=target.id,
            x=target.screen_point[0],
            y=target.screen_point[1],
        )

    if kind == ActionKind.TYPE_TEXT:
        if decision.key is not None or not decision.input_key:
            raise ReflexError("type_fields_invalid")
        if not target.focused:
            raise ReflexError("target_not_focused")
        if decision.input_key not in subtask.inputs:
            raise ReflexError("unknown_input_key")
        return ExecutableAction(
            kind=kind,
            target_id=target.id,
            text=subtask.inputs[decision.input_key],
        )

    raise ReflexError("unsupported_action_kind")


class DesktopExecutor:
    """Run one bounded reflex episode below the planner.

    The policy can choose only a legal operation/element/input-key tuple. It cannot
    supply host coordinates or literal text. Failed/stale effects are never replayed
    automatically; the runtime re-observes and asks the policy again.
    """

    _STALE_REASONS = frozenset(
        {
            "fresh_observation_required",
            "observation_stale",
            "target_changed",
            "element_stale",
            "frame_scene_changed",
            "frame-scene-changed",
        }
    )

    def __init__(
        self,
        backend: ReflexBackend,
        policy: DecisionPolicy,
        *,
        config: ExecutorConfig | None = None,
        verifier: CompletionVerifier | None = None,
        press_keys: Sequence[str] = DEFAULT_PRESS_KEYS,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.backend = backend
        self.policy = policy
        self.config = config or ExecutorConfig()
        self.verifier = verifier
        self.press_keys = tuple(str(key).upper() for key in press_keys)
        self._monotonic = monotonic
        self._sleep = sleep

    def run(
        self,
        subtask: Subtask,
        *,
        continuation: ExecutionResult | None = None,
    ) -> ExecutionResult:
        """Continue the same episode without renewing its action/evidence budgets.

        A continuation carries cumulative successful action history for both the
        actor and verifier. It is in-process state, never effect authority. Failed
        effects must be reconciled by the caller and cannot enter this path.
        """
        history: list[ActionRecord] = []
        verification_continues = 0
        if continuation is not None:
            if (
                type(continuation) is not ExecutionResult
                or continuation.subtask != subtask
                or type(continuation.status) is not TerminalKind
                or continuation.status not in {TerminalKind.BLOCKED, TerminalKind.NEEDS_AGENT}
                or type(continuation.evidence_epoch) is not int
                or continuation.evidence_epoch != 0
                or not isinstance(continuation.final_snapshot, DesktopSnapshot)
                or not isinstance(continuation.final_snapshot.context, Mapping)
                or type(continuation.history) is not tuple
                or len(continuation.history) > subtask.max_actions
                or type(continuation.verification_continues) is not int
                or not 0 <= continuation.verification_continues <= MAX_VERIFICATION_CONTINUES
                or (continuation.reason is not None and not isinstance(continuation.reason, str))
                or (
                    continuation.verification is not None
                    and (
                        type(continuation.verification) is not VerificationDecision
                        or continuation.verification.kind == VerificationKind.VERIFIED_COMPLETE
                    )
                )
                or any(
                    type(record) is not ActionRecord
                    or type(record.step) is not int
                    or record.step != index
                    or not isinstance(record.action, ExecutableAction)
                    or not isinstance(record.receipt, Mapping)
                    or record.receipt.get("ok") is not True
                    for index, record in enumerate(continuation.history, 1)
                )
            ):
                raise ReflexError("continuation_invalid")
            if (continuation.reason or "").startswith("effect_refused:"):
                raise ReflexError("continuation_effect_reconciliation_required")
            history = list(continuation.history)
            verification_continues = continuation.verification_continues
            if verification_continues >= MAX_VERIFICATION_CONTINUES or (
                continuation.reason or ""
            ).startswith("verification_continue_bound:"):
                reason = (
                    continuation.reason
                    if (continuation.reason or "").startswith("verification_continue_bound:")
                    else f"verification_continue_bound:{MAX_VERIFICATION_CONTINUES}"
                )
                return ExecutionResult(
                    status=TerminalKind.NEEDS_AGENT,
                    subtask=subtask,
                    final_snapshot=continuation.final_snapshot,
                    history=tuple(history),
                    reason=reason,
                    verification=VerificationDecision(VerificationKind.ESCALATE, reason=reason),
                    verification_continues=verification_continues,
                )
            if len(history) >= subtask.max_actions:
                return ExecutionResult(
                    status=TerminalKind.NEEDS_AGENT,
                    subtask=subtask,
                    final_snapshot=continuation.final_snapshot,
                    history=tuple(history),
                    reason=f"action_budget_reached:{subtask.max_actions}",
                    verification_continues=verification_continues,
                )
        snapshot = self.backend.observe()
        if continuation is not None and (
            snapshot.context.get("target") != continuation.final_snapshot.context.get("target")
        ):
            raise ReflexError("continuation_target_changed")
        stale_retries = 0

        while len(history) < subtask.max_actions:
            decision = self.policy.decide(
                subtask=subtask,
                snapshot=snapshot,
                history=tuple(history),
                legal_actions=legal_action_space(snapshot, subtask, press_keys=self.press_keys),
            )
            if decision.terminal is not None:
                if decision.terminal != TerminalKind.SUBTASK_COMPLETE:
                    return ExecutionResult(
                        status=decision.terminal,
                        subtask=subtask,
                        final_snapshot=snapshot,
                        history=tuple(history),
                        verification_continues=verification_continues,
                    )
                # Completion is only a proposal from the actor. Re-observe after
                # the proposal and require a separate verifier to establish fresh
                # external evidence. Internal policy narration cannot advance the
                # evidence epoch.
                fresh = self.backend.observe()
                if self.verifier is None:
                    return ExecutionResult(
                        status=TerminalKind.NEEDS_AGENT,
                        subtask=subtask,
                        final_snapshot=fresh,
                        history=tuple(history),
                        reason="completion_verifier_required",
                        verification_continues=verification_continues,
                    )
                verification = self.verifier.verify(
                    subtask=subtask,
                    snapshot=fresh,
                    history=tuple(history),
                )
                if verification.kind == VerificationKind.VERIFIED_COMPLETE:
                    return ExecutionResult(
                        status=TerminalKind.SUBTASK_COMPLETE,
                        subtask=subtask,
                        final_snapshot=fresh,
                        history=tuple(history),
                        evidence_epoch=1,
                        verification=verification,
                        verification_continues=verification_continues,
                    )
                if verification.kind == VerificationKind.ESCALATE:
                    return ExecutionResult(
                        status=TerminalKind.NEEDS_AGENT,
                        subtask=subtask,
                        final_snapshot=fresh,
                        history=tuple(history),
                        reason=verification.reason or "verification_escalated",
                        verification=verification,
                        verification_continues=verification_continues,
                    )
                # CONTINUE consumes no action budget and advances no evidence,
                # but must be bounded even without a verifier-side wrapper.
                # Count across intervening actions, not just consecutive proposals.
                verification_continues += 1
                if verification_continues >= MAX_VERIFICATION_CONTINUES:
                    reason = f"verification_continue_bound:{MAX_VERIFICATION_CONTINUES}"
                    return ExecutionResult(
                        status=TerminalKind.NEEDS_AGENT,
                        subtask=subtask,
                        final_snapshot=fresh,
                        history=tuple(history),
                        reason=reason,
                        verification=VerificationDecision(
                            VerificationKind.ESCALATE,
                            reason=reason,
                        ),
                        verification_continues=verification_continues,
                    )
                snapshot = fresh
                continue

            action = materialize_action(
                decision,
                snapshot,
                subtask,
                press_keys=self.press_keys,
            )
            before = snapshot
            receipt = dict(
                self.backend.execute(
                    before,
                    action,
                    public_rationale=" ".join(decision.public_rationale.split()),
                )
            )
            if receipt.get("ok") is not True:
                reason = str(receipt.get("reason_code") or "effect_failed")
                if reason in self._STALE_REASONS and stale_retries < self.config.stale_retries:
                    stale_retries += 1
                    snapshot = self.backend.observe()
                    continue
                return ExecutionResult(
                    status=TerminalKind.NEEDS_AGENT,
                    subtask=subtask,
                    final_snapshot=before,
                    history=tuple(history),
                    reason=f"effect_refused:{reason}",
                    verification_continues=verification_continues,
                )

            stale_retries = 0
            snapshot = self._observe_settled(action)
            history.append(
                ActionRecord(
                    step=len(history) + 1,
                    action=action,
                    before_revision=before.revision,
                    after_revision=snapshot.revision,
                    state_changed=before.revision != snapshot.revision,
                    receipt=receipt,
                )
            )
            recent = history[-self.config.no_change_limit :]
            if len(recent) == self.config.no_change_limit and all(
                not record.state_changed for record in recent
            ):
                return ExecutionResult(
                    status=TerminalKind.BLOCKED,
                    subtask=subtask,
                    final_snapshot=snapshot,
                    history=tuple(history),
                    reason=(f"no_observable_change_after_{self.config.no_change_limit}_actions"),
                    verification_continues=verification_continues,
                )

        return ExecutionResult(
            status=TerminalKind.NEEDS_AGENT,
            subtask=subtask,
            final_snapshot=snapshot,
            history=tuple(history),
            reason=f"action_budget_reached:{subtask.max_actions}",
            verification_continues=verification_continues,
        )

    def _observe_settled(self, action: ExecutableAction) -> DesktopSnapshot:
        started = self._monotonic()
        deadline = started + self.config.settle_timeout_ms / 1000.0
        minimum = (
            self.config.type_settle_min_ms
            if action.kind == ActionKind.TYPE_TEXT
            else self.config.settle_min_ms
        ) / 1000.0
        latest = self.backend.observe()
        previous_revision: str | None = None
        stable_frames = 0

        while self._monotonic() < deadline:
            if latest.revision == previous_revision:
                stable_frames += 1
            else:
                previous_revision = latest.revision
                stable_frames = 0
            if self._monotonic() - started >= minimum and stable_frames >= 1:
                return latest
            self._sleep(self.config.settle_poll_ms / 1000.0)
            latest = self.backend.observe()
        return latest


class AppControllerElementBackend:
    """Canonical semantic adapter over the existing owner-gated AppController.

    The adapter owns no authority. It obtains a fresh AppController observation
    immediately before every effect, re-runs the perception-only element provider,
    verifies that the selected semantic target is still the same actionable
    element, and then invokes the existing AppController binding/grant/receipt
    path. Click geometry is rebound from the fresh observation; typed literals
    still come only from the planner-owned Subtask.
    """

    def __init__(
        self,
        controller: Any,
        element_provider: Callable[[Mapping[str, Any]], Sequence[DesktopElement]],
    ) -> None:
        self.controller = controller
        self.element_provider = element_provider

    def _snapshot_from_raw(self, raw: Mapping[str, Any]) -> DesktopSnapshot:
        if raw.get("ok") is not True:
            raise ReflexError(str(raw.get("reason_code") or "observe_failed"))
        elements = tuple(self.element_provider(raw))
        if any(not isinstance(item, DesktopElement) for item in elements):
            raise ReflexError("element_provider_type_invalid")
        revision = _structural_revision(raw.get("target"), elements)
        return DesktopSnapshot(
            observation_id=str(raw["observation_id"]),
            revision=revision,
            elements=elements,
            context={"target": raw.get("target")},
        )

    def observe(self) -> DesktopSnapshot:
        """Observe through the controller and attach perceived elements."""
        return self._snapshot_from_raw(dict(self.controller.observe()))

    @staticmethod
    def _stale_refusal() -> Mapping[str, Any]:
        return {
            "ok": False,
            "reason_code": "element_stale",
            "host_input_fired": False,
        }

    def _revalidate(
        self,
        snapshot: DesktopSnapshot,
        action: ExecutableAction,
    ) -> tuple[DesktopSnapshot, DesktopElement | None, Mapping[str, Any] | None]:
        current = self.observe()

        # A semantic row can be identical in a different app/window/tab.
        # Compare only supplied binding facts; this cannot invent tab identity.
        prior_binding = snapshot.context.get("target")
        fresh_binding = current.context.get("target")
        if (
            type(prior_binding) is not dict
            or not prior_binding
            or type(fresh_binding) is not dict
            or not fresh_binding
            or prior_binding != fresh_binding
        ):
            return current, None, self._stale_refusal()

        if action.target_id is None:
            if current.revision != snapshot.revision:
                return current, None, self._stale_refusal()
            return current, None, None

        try:
            prior_target = snapshot.element(action.target_id)
            current_target = current.element(action.target_id)
        except ReflexError:
            return current, None, self._stale_refusal()

        if (
            not current_target.visible
            or not current_target.enabled
            or action.kind not in current_target.actions
            or prior_target.semantic_guard() != current_target.semantic_guard()
        ):
            return current, None, self._stale_refusal()

        if action.kind == ActionKind.TYPE_TEXT and not current_target.focused:
            return current, None, self._stale_refusal()

        return current, current_target, None

    def execute(
        self,
        snapshot: DesktopSnapshot,
        action: ExecutableAction,
        *,
        public_rationale: str,
    ) -> Mapping[str, Any]:
        """Revalidate the target against a fresh observation, then run the effect.

        If the app, the window or the selected element's meaning changed since the policy chose,
        the effect is refused as ``element_stale`` and nothing reaches the controller. Clicks use
        the freshly observed point, not the one the policy saw.
        """
        current, current_target, refusal = self._revalidate(snapshot, action)
        if refusal is not None:
            return refusal

        if action.kind == ActionKind.FOCUS:
            return self.controller.focus(current.observation_id, public_rationale)
        if action.kind == ActionKind.PRESS_KEY:
            return self.controller.key(
                str(action.key or ""),
                current.observation_id,
                public_rationale,
            )
        if action.kind == ActionKind.TYPE_TEXT:
            return self.controller.type_text(
                str(action.text or ""),
                current.observation_id,
                public_rationale,
            )
        if action.kind == ActionKind.CLICK:
            if current_target is None or current_target.screen_point is None:
                return self._stale_refusal()
            x, y = current_target.screen_point
            if type(x) is not int or type(y) is not int:
                raise ReflexError("materialized_point_missing")
            return self.controller.click(
                x,
                y,
                current.observation_id,
                public_rationale,
            )
        raise ReflexError("unsupported_action_kind")


def _structural_revision(
    target: Any,
    elements: Sequence[DesktopElement],
) -> str:
    payload = {
        "target": target,
        "elements": [element.signature() for element in elements],
    }
    return hashlib.sha256(
        json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            default=str,
        ).encode("utf-8")
    ).hexdigest()
