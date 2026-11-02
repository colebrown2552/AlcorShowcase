"""Legal action space, materialisation, stale handling and independent completion."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from alcor_computer.app_control import GRANT_SCHEMA, AppController
from alcor_computer.backends.base import BackendError
from alcor_computer.reflex_executor import (
    ActionKind,
    AppControllerElementBackend,
    Decision,
    DesktopElement,
    DesktopExecutor,
    DesktopSnapshot,
    ExecutorConfig,
    ReflexError,
    Subtask,
    TerminalKind,
    VerificationDecision,
    VerificationKind,
    legal_action_space,
    materialize_action,
)


def _private_temporary_directory():
    """A temp dir for the grant and receipts. AppController demands an owner-private directory.

    POSIX temp dirs are mode 0700. On Windows the directory's ACL must pass the controller's own
    check, which Python 3.12.4 and newer satisfy; elsewhere the caller skips.
    """
    return tempfile.TemporaryDirectory(ignore_cleanup_errors=True)


def _temp_dir_is_private() -> bool:
    if os.name != "nt":
        return True
    from alcor_computer.backends.windows_private import is_private

    with tempfile.TemporaryDirectory() as directory:
        return is_private(Path(directory))


def snapshot(revision: str = "r0", observation_id: str = "obs0") -> DesktopSnapshot:
    return DesktopSnapshot(
        observation_id=observation_id,
        revision=revision,
        elements=(
            DesktopElement(
                id="search",
                role="text_field",
                name="Search",
                actions=(ActionKind.CLICK, ActionKind.TYPE_TEXT),
                screen_point=(120, 80),
                value="",
                focused=True,
                source="fixture",
            ),
            DesktopElement(
                id="label",
                role="label",
                name="Result",
                actions=(ActionKind.CLICK,),
                screen_point=(240, 160),
                source="fixture",
            ),
        ),
    )


class ScriptedPolicy:
    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.spaces = []

    def decide(self, *, subtask, snapshot, history, legal_actions):
        self.spaces.append(dict(legal_actions))
        if not self.decisions:
            return Decision(terminal=TerminalKind.NEEDS_AGENT)
        return self.decisions.pop(0)


class AlwaysVerify:
    def verify(self, *, subtask, snapshot, history):
        return VerificationDecision(
            VerificationKind.VERIFIED_COMPLETE,
            evidence=("fixture external verification",),
        )


class FakeBackend:
    def __init__(self, *, change_on_effect: bool = False, stale_once: bool = False):
        self.revision = "r0"
        self.sequence = 0
        self.change_on_effect = change_on_effect
        self.stale_once = stale_once
        self.executions = []

    def observe(self):
        self.sequence += 1
        base = snapshot(self.revision, f"obs{self.sequence}")
        return base

    def execute(self, observed, action, *, public_rationale):
        self.executions.append((observed.observation_id, action, public_rationale))
        if self.stale_once:
            self.stale_once = False
            return {"ok": False, "reason_code": "observation_stale"}
        if self.change_on_effect:
            self.revision = f"r{len(self.executions)}"
        return {"ok": True, "reason_code": "performed"}


class ReflexExecutorTests(unittest.TestCase):
    def test_literal_text_can_only_come_from_subtask_input(self) -> None:
        task = Subtask(
            goal="Search effects",
            verification=("Search contains Gaussian Blur",),
            inputs={"effect_name": "Gaussian Blur"},
        )
        action = materialize_action(
            Decision(
                kind=ActionKind.TYPE_TEXT,
                target_id="search",
                input_key="effect_name",
            ),
            snapshot(),
            task,
        )
        self.assertEqual(action.text, "Gaussian Blur")
        self.assertEqual(action.target_id, "search")

    def test_unknown_input_key_is_rejected(self) -> None:
        task = Subtask(
            goal="Search",
            verification=("Search contains x",),
            inputs={"query": "x"},
        )
        with self.assertRaisesRegex(ReflexError, "unknown_input_key"):
            materialize_action(
                Decision(
                    kind=ActionKind.TYPE_TEXT,
                    target_id="search",
                    input_key="invented",
                ),
                snapshot(),
                task,
            )

    def test_policy_never_supplies_coordinates(self) -> None:
        task = Subtask(goal="Click result", verification=("Result opened",))
        action = materialize_action(
            Decision(kind=ActionKind.CLICK, target_id="label"),
            snapshot(),
            task,
        )
        self.assertEqual((action.x, action.y), (240, 160))

    def test_dynamic_action_space_exposes_only_legal_targets(self) -> None:
        task = Subtask(
            goal="Search",
            verification=("Search contains x",),
            inputs={"query": "x"},
        )
        space = legal_action_space(snapshot(), task)
        self.assertIn("CLICK", space["operations"])
        self.assertIn("TYPE_TEXT", space["operations"])
        self.assertEqual(space["click_targets"], ["search", "label"])
        self.assertEqual(space["type_targets"], ["search"])
        self.assertEqual(space["input_keys"], ["query"])

    def test_no_change_loop_returns_blocked(self) -> None:
        backend = FakeBackend(change_on_effect=False)
        policy = ScriptedPolicy(
            [Decision(kind=ActionKind.CLICK, target_id="label") for _ in range(3)]
        )
        executor = DesktopExecutor(
            backend,
            policy,
            config=ExecutorConfig(
                no_change_limit=3,
                settle_min_ms=0,
                type_settle_min_ms=0,
                settle_timeout_ms=2,
                settle_poll_ms=1,
            ),
        )
        result = executor.run(
            Subtask(
                goal="Open result",
                verification=("Result is open",),
                max_actions=5,
            )
        )
        self.assertEqual(result.status, TerminalKind.BLOCKED)
        self.assertEqual(result.actions_taken, 3)
        self.assertTrue(all(not row.state_changed for row in result.history))

    def test_stale_effect_is_reobserved_and_redecided_not_replayed(self) -> None:
        backend = FakeBackend(change_on_effect=True, stale_once=True)
        policy = ScriptedPolicy(
            [
                Decision(
                    kind=ActionKind.CLICK, target_id="label", public_rationale="first observation"
                ),
                Decision(
                    kind=ActionKind.CLICK, target_id="label", public_rationale="fresh observation"
                ),
                Decision(terminal=TerminalKind.SUBTASK_COMPLETE),
            ]
        )
        executor = DesktopExecutor(
            backend,
            policy,
            verifier=AlwaysVerify(),
            config=ExecutorConfig(
                stale_retries=2,
                no_change_limit=3,
                settle_min_ms=0,
                type_settle_min_ms=0,
                settle_timeout_ms=2,
                settle_poll_ms=1,
            ),
        )
        result = executor.run(Subtask(goal="Open result", verification=("Result is open",)))
        self.assertEqual(result.status, TerminalKind.SUBTASK_COMPLETE)
        self.assertEqual(result.actions_taken, 1)
        self.assertEqual(len(backend.executions), 2)
        self.assertNotEqual(backend.executions[0][0], backend.executions[1][0])
        self.assertEqual(
            [row[2] for row in backend.executions],
            ["first observation", "fresh observation"],
        )

    def test_action_budget_returns_needs_agent(self) -> None:
        backend = FakeBackend(change_on_effect=True)
        policy = ScriptedPolicy(
            [Decision(kind=ActionKind.CLICK, target_id="label") for _ in range(2)]
        )
        result = DesktopExecutor(
            backend,
            policy,
            config=ExecutorConfig(
                settle_min_ms=0,
                type_settle_min_ms=0,
                settle_timeout_ms=2,
                settle_poll_ms=1,
            ),
        ).run(
            Subtask(
                goal="Keep going",
                verification=("Done",),
                max_actions=2,
            )
        )
        self.assertEqual(result.status, TerminalKind.NEEDS_AGENT)
        self.assertEqual(result.reason, "action_budget_reached:2")

    def test_app_controller_adapter_preserves_existing_authority_path(self) -> None:
        class Controller:
            def __init__(self):
                self.sequence = 0
                self.clicks = []

            def observe(self):
                self.sequence += 1
                return {
                    "ok": True,
                    "observation_id": f"appobs_{self.sequence}",
                    "target": {
                        "title": "fixture",
                        "window_bounds": {"x": 0, "y": 0, "width": 800, "height": 600},
                    },
                }

            def click(self, x, y, observation_id, rationale):
                self.clicks.append((x, y, observation_id, rationale))
                return {"ok": True, "reason_code": "performed"}

        controller = Controller()
        backend = AppControllerElementBackend(
            controller,
            lambda raw: (
                DesktopElement(
                    id="button",
                    role="button",
                    name="Go",
                    actions=(ActionKind.CLICK,),
                    screen_point=(33, 44),
                    source="fixture",
                ),
            ),
        )
        observed = backend.observe()
        receipt = backend.execute(
            observed,
            materialize_action(
                Decision(kind=ActionKind.CLICK, target_id="button"),
                observed,
                Subtask(goal="Go", verification=("Gone",)),
            ),
            public_rationale="fixture click",
        )
        self.assertTrue(receipt["ok"])
        self.assertEqual(controller.clicks, [(33, 44, "appobs_2", "fixture click")])

    def test_type_text_requires_perception_proven_focus(self) -> None:
        task = Subtask(
            goal="Type",
            verification=("Typed",),
            inputs={"text": "hello"},
        )
        unfocused = DesktopSnapshot(
            observation_id="obs0",
            revision="r0",
            elements=(
                DesktopElement(
                    id="field",
                    role="text_field",
                    name="Field",
                    actions=(ActionKind.TYPE_TEXT,),
                    focused=False,
                ),
            ),
        )
        self.assertNotIn(
            ActionKind.TYPE_TEXT.value, legal_action_space(unfocused, task)["operations"]
        )
        with self.assertRaisesRegex(ReflexError, "target_not_focused"):
            materialize_action(
                Decision(
                    kind=ActionKind.TYPE_TEXT,
                    target_id="field",
                    input_key="text",
                ),
                unfocused,
                task,
            )

    def test_semantic_target_is_revalidated_before_effect(self) -> None:
        class Controller:
            def __init__(self):
                self.sequence = 0
                self.clicks = []

            def observe(self):
                self.sequence += 1
                return {
                    "ok": True,
                    "observation_id": f"appobs_{self.sequence}",
                    "target": {
                        "title": "fixture",
                        "window_bounds": {"x": 0, "y": 0, "width": 800, "height": 600},
                    },
                }

            def click(self, x, y, observation_id, rationale):
                self.clicks.append((x, y, observation_id, rationale))
                return {"ok": True, "reason_code": "performed"}

        semantic_name = ["Go"]
        controller = Controller()
        backend = AppControllerElementBackend(
            controller,
            lambda raw: (
                DesktopElement(
                    id="button",
                    role="button",
                    name=semantic_name[0],
                    actions=(ActionKind.CLICK,),
                    screen_point=(33, 44),
                    source="fixture",
                ),
            ),
        )
        observed = backend.observe()
        action = materialize_action(
            Decision(kind=ActionKind.CLICK, target_id="button"),
            observed,
            Subtask(goal="Go", verification=("Gone",)),
        )
        semantic_name[0] = "Different control"
        receipt = backend.execute(
            observed,
            action,
            public_rationale="fixture click",
        )
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["reason_code"], "element_stale")
        self.assertFalse(receipt["host_input_fired"])
        self.assertEqual(controller.clicks, [])

    @unittest.skipUnless(_temp_dir_is_private(), "temporary directories are not private here")
    def test_real_app_controller_integration_preserves_grant_and_receipt_authority(self) -> None:
        now = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc).timestamp()
        target = "com.example.ReflexFixture"

        def iso(epoch):
            return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        class HostBackend:
            name = "reflex-fixture"

            def __init__(self):
                self.target_bundle_id = target
                self.state = {
                    "bundle_id": target,
                    "pid": 42,
                    "process": "ReflexFixture",
                    "window_title": "Reflex fixture",
                    "window_bounds": {"x": 10, "y": 20, "width": 400, "height": 300},
                    "frontmost": True,
                }
                self.prepared = None
                self.calls = []

            def status(self):
                return {
                    "ok": True,
                    "backend": self.name,
                    "target_bundle_id": self.target_bundle_id,
                }

            def target_state(self):
                return json.loads(json.dumps(self.state))

            def prepare_action(self, expected_target, action):
                if expected_target != self.state:
                    raise BackendError("target_changed_since_observation")
                if action["kind"] in {"move", "click"}:
                    bounds = self.state["window_bounds"]
                    if not (
                        bounds["x"] <= action["x"] < bounds["x"] + bounds["width"]
                        and bounds["y"] <= action["y"] < bounds["y"] + bounds["height"]
                    ):
                        raise BackendError("pointer_outside_target_window")
                self.prepared = dict(action)

            def screen_size(self):
                return (1280, 720)

            def foreground_window(self):
                return self.target_state()

            def screenshot(self, path):
                raise BackendError("screenshot_capture_not_enabled")

            def perform(self, action):
                if self.prepared != action:
                    raise BackendError("action_not_prepared")
                self.prepared = None
                self.calls.append(dict(action))

        with _private_temporary_directory() as temporary:
            root = Path(temporary)
            grant_path = root / "grant.json"
            receipt_path = root / "receipts.jsonl"
            grant_path.write_text(
                json.dumps(
                    {
                        "schema": GRANT_SCHEMA,
                        "target_bundle_id": target,
                        "issued_at": iso(now - 1),
                        "expires_at": iso(now + 120),
                        "max_events": 4,
                        "allowed_actions": ["click"],
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            grant_path.chmod(0o600)

            host = HostBackend()
            controller = AppController(
                target,
                live_opt_in=True,
                ttl_seconds=120,
                max_events=4,
                max_observation_age_ms=2_000,
                grant_path=grant_path,
                receipt_path=receipt_path,
                backend=host,
                monotonic=lambda: 100.0,
                wall_time=lambda: now,
            )
            try:
                backend = AppControllerElementBackend(
                    controller,
                    lambda raw: (
                        DesktopElement(
                            id="go",
                            role="button",
                            name="Go",
                            actions=(ActionKind.CLICK,),
                            screen_point=(50, 60),
                            source="fixture",
                        ),
                    ),
                )
                policy = ScriptedPolicy(
                    [
                        Decision(kind=ActionKind.CLICK, target_id="go"),
                        Decision(terminal=TerminalKind.SUBTASK_COMPLETE),
                    ]
                )
                result = DesktopExecutor(
                    backend,
                    policy,
                    verifier=AlwaysVerify(),
                    config=ExecutorConfig(
                        no_change_limit=3,
                        settle_min_ms=0,
                        type_settle_min_ms=0,
                        settle_timeout_ms=2,
                        settle_poll_ms=1,
                    ),
                ).run(
                    Subtask(
                        goal="Click Go",
                        verification=("Go action dispatched",),
                        max_actions=2,
                    )
                )
                self.assertEqual(result.status, TerminalKind.SUBTASK_COMPLETE)
                self.assertEqual(result.actions_taken, 1)
                self.assertEqual(len(host.calls), 1)
                self.assertEqual(host.calls[0]["kind"], "click")
                self.assertEqual((host.calls[0]["x"], host.calls[0]["y"]), (50, 60))
                self.assertTrue(result.history[0].receipt["ok"])
                self.assertTrue(result.history[0].receipt["host_input_fired"])
            finally:
                controller.close()
            durable = receipt_path.read_text(encoding="utf-8")
            self.assertIn('"reason_code":"effect_pending"', durable)
            self.assertIn('"reason_code":"performed"', durable)

    def test_actor_cannot_complete_without_independent_verifier(self) -> None:
        backend = FakeBackend(change_on_effect=False)
        policy = ScriptedPolicy([Decision(terminal=TerminalKind.SUBTASK_COMPLETE)])
        result = DesktopExecutor(backend, policy).run(
            Subtask(goal="Done", verification=("External state proves done",))
        )
        self.assertEqual(result.status, TerminalKind.NEEDS_AGENT)
        self.assertEqual(result.reason, "completion_verifier_required")
        self.assertEqual(result.evidence_epoch, 0)

    def test_verified_completion_advances_evidence_epoch_once(self) -> None:
        class Verifier:
            def __init__(self):
                self.calls = []

            def verify(self, *, subtask, snapshot, history):
                self.calls.append(snapshot.observation_id)
                return VerificationDecision(
                    VerificationKind.VERIFIED_COMPLETE,
                    evidence=("fresh fixture observation satisfies criterion",),
                )

        backend = FakeBackend(change_on_effect=False)
        verifier = Verifier()
        result = DesktopExecutor(
            backend,
            ScriptedPolicy([Decision(terminal=TerminalKind.SUBTASK_COMPLETE)]),
            verifier=verifier,
        ).run(Subtask(goal="Done", verification=("External state proves done",)))
        self.assertEqual(result.status, TerminalKind.SUBTASK_COMPLETE)
        self.assertEqual(result.evidence_epoch, 1)
        self.assertEqual(result.verification.kind, VerificationKind.VERIFIED_COMPLETE)
        self.assertEqual(len(verifier.calls), 1)
        self.assertGreaterEqual(backend.sequence, 2)

    def test_verifier_continue_returns_control_to_actor_without_epoch(self) -> None:
        class Verifier:
            def verify(self, *, subtask, snapshot, history):
                return VerificationDecision(
                    VerificationKind.CONTINUE,
                    reason="criterion not yet observable",
                )

        backend = FakeBackend(change_on_effect=True)
        policy = ScriptedPolicy(
            [
                Decision(terminal=TerminalKind.SUBTASK_COMPLETE),
                Decision(kind=ActionKind.CLICK, target_id="label"),
            ]
        )
        result = DesktopExecutor(
            backend,
            policy,
            verifier=Verifier(),
            config=ExecutorConfig(
                settle_min_ms=0,
                type_settle_min_ms=0,
                settle_timeout_ms=2,
                settle_poll_ms=1,
            ),
        ).run(Subtask(goal="Finish", verification=("Done",), max_actions=1))
        self.assertEqual(result.status, TerminalKind.NEEDS_AGENT)
        self.assertEqual(result.evidence_epoch, 0)
        self.assertEqual(result.actions_taken, 1)

    def test_verifier_escalate_never_marks_complete(self) -> None:
        class Verifier:
            def verify(self, *, subtask, snapshot, history):
                return VerificationDecision(
                    VerificationKind.ESCALATE,
                    reason="ambiguous visual evidence",
                )

        result = DesktopExecutor(
            FakeBackend(),
            ScriptedPolicy([Decision(terminal=TerminalKind.SUBTASK_COMPLETE)]),
            verifier=Verifier(),
        ).run(Subtask(goal="Finish", verification=("Done",)))
        self.assertEqual(result.status, TerminalKind.NEEDS_AGENT)
        self.assertEqual(result.reason, "ambiguous visual evidence")
        self.assertEqual(result.evidence_epoch, 0)

    def test_subtask_literal_budget_is_bounded(self) -> None:
        with self.assertRaisesRegex(ReflexError, "subtask_input_value_invalid"):
            Subtask(
                goal="Type",
                verification=("Typed",),
                inputs={"text": "x" * 1025},
            )


if __name__ == "__main__":
    unittest.main()
