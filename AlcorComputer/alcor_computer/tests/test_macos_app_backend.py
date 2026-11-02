"""The macOS app backend's prepare-then-perform protocol with injected providers."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from alcor_computer.backends.base import BackendError
from alcor_computer.backends.macos_app import MacOSAppBackend

TARGET = "com.example.Fixture"


def state(*, pid: int = 42, frontmost: bool = True) -> dict:
    return {
        "ok": True,
        "bundle_id": TARGET,
        "pid": pid,
        "process": "Fixture",
        "window_title": "Fixture window",
        "window_bounds": {"x": 10, "y": 20, "width": 400, "height": 300},
        "frontmost": frontmost,
    }


class MacOSAppBackendTests(unittest.TestCase):
    def test_prepared_action_is_reverified_and_consumed_once(self) -> None:
        current = state()
        fired = []
        backend = MacOSAppBackend(
            TARGET,
            snapshot_provider=lambda: dict(current),
            effect_provider=lambda action, target: fired.append((dict(action), dict(target))),
            monotonic=lambda: 10.0,
        )
        expected = backend.target_state()
        action = {"kind": "click", "x": 50, "y": 60, "button": "left"}
        backend.prepare_action(expected, action)
        backend.perform(action)
        self.assertEqual(len(fired), 1)
        with self.assertRaises(BackendError) as raised:
            backend.perform(action)
        self.assertEqual(raised.exception.reason_code, "action_not_prepared")

    def test_identity_change_between_prepare_and_perform_refuses(self) -> None:
        current = state()
        fired = []
        backend = MacOSAppBackend(
            TARGET,
            snapshot_provider=lambda: dict(current),
            effect_provider=lambda action, target: fired.append((action, target)),
            monotonic=lambda: 10.0,
        )
        expected = backend.target_state()
        action = {"kind": "key", "key": "a"}
        backend.prepare_action(expected, action)
        current["pid"] = 99
        with self.assertRaises(BackendError) as raised:
            backend.perform(action)
        self.assertEqual(raised.exception.reason_code, "target_changed_before_effect")
        self.assertEqual(fired, [])

    def test_nonfrontmost_and_out_of_window_effects_refuse(self) -> None:
        current = state(frontmost=False)
        backend = MacOSAppBackend(TARGET, snapshot_provider=lambda: dict(current))
        with self.assertRaises(BackendError) as raised:
            backend.prepare_action(current, {"kind": "key", "key": "a"})
        self.assertEqual(raised.exception.reason_code, "target_not_frontmost")

        current["frontmost"] = True
        with self.assertRaises(BackendError) as raised:
            backend.prepare_action(current, {"kind": "move", "x": 900, "y": 700})
        self.assertEqual(raised.exception.reason_code, "pointer_outside_target_window")

    def test_focus_never_changes_target_and_must_be_observed_as_frontmost(self) -> None:
        current = state(frontmost=False)

        def effect(action, _target):
            self.assertEqual(action["kind"], "focus")
            current["frontmost"] = True

        backend = MacOSAppBackend(
            TARGET,
            snapshot_provider=lambda: dict(current),
            effect_provider=effect,
            monotonic=lambda: 10.0,
        )
        backend.prepare_action(backend.target_state(), {"kind": "focus"})
        backend.perform({"kind": "focus"})
        self.assertTrue(backend.target_state()["frontmost"])

    def test_keyboard_rechecks_target_in_same_stdin_script_without_plaintext_argv(self) -> None:
        backend = MacOSAppBackend(TARGET, snapshot_provider=lambda: state())
        completed = type("Completed", (), {"returncode": 0, "stdout": "OK\n"})()
        secret = "fixture private text"
        with patch(
            "alcor_computer.backends.macos_app.subprocess.run",
            return_value=completed,
        ) as run:
            backend._keyboard({"kind": "type", "text": secret}, state())
        argv = run.call_args.args[0]
        self.assertNotIn(secret, " ".join(argv))
        script = run.call_args.kwargs["input"]
        self.assertIn(TARGET, script)
        self.assertIn("frontmost", script)
        self.assertIn(secret, script)


if __name__ == "__main__":
    unittest.main()
