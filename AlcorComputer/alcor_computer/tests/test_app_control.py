"""Owner grants and the AppController gates, against an in-memory backend."""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from alcor_computer.app_control import (
    GRANT_SCHEMA,
    AppControlError,
    AppController,
    load_owner_grant,
)
from alcor_computer.backends.base import BackendError

NOW = datetime(2026, 9, 8, 22, 0, tzinfo=timezone.utc).timestamp()
TARGET = "com.example.Fixture"


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write_grant(
    path: Path,
    *,
    now: float = NOW,
    target: str = TARGET,
    max_events: int = 4,
    actions: list[str] | None = None,
) -> None:
    path.write_text(
        json.dumps(
            {
                "schema": GRANT_SCHEMA,
                "target_bundle_id": target,
                "issued_at": _iso(now - 1),
                "expires_at": _iso(now + 120),
                "max_events": max_events,
                "allowed_actions": actions or ["focus", "key", "type", "move", "click"],
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    path.chmod(0o600)


class FakeAppBackend:
    name = "fixture-app"

    def __init__(self, target_bundle_id: str = TARGET, *, frontmost: bool = True) -> None:
        self.target_bundle_id = target_bundle_id
        self.state = {
            "bundle_id": target_bundle_id,
            "pid": 42,
            "process": "Fixture",
            "window_title": "Fixture window",
            "window_bounds": {"x": 10, "y": 20, "width": 400, "height": 300},
            "frontmost": frontmost,
        }
        self.prepared: dict | None = None
        self.calls: list[dict] = []

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
        if action["kind"] != "focus" and not self.state["frontmost"]:
            raise BackendError("target_not_frontmost")
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
        if action["kind"] == "focus":
            self.state["frontmost"] = True


def _temp_dir_is_private() -> bool:
    """POSIX temp dirs are mode 0700. On Windows the ACL must pass the controller's own check."""
    if os.name != "nt":
        return True
    from alcor_computer.backends.windows_private import is_private

    with tempfile.TemporaryDirectory() as directory:
        return is_private(Path(directory))


class OwnerGrantTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "asserts POSIX permission bits; Windows uses NTFS ACLs")
    def test_grant_is_closed_short_lived_target_bound_and_owner_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "grant.json"
            _write_grant(path)
            grant = load_owner_grant(path, target_bundle_id=TARGET, now_epoch=NOW)
            self.assertEqual(grant.max_events, 4)
            self.assertIn("click", grant.allowed_actions)

            path.chmod(0o644)
            with self.assertRaises(AppControlError) as raised:
                load_owner_grant(path, target_bundle_id=TARGET, now_epoch=NOW)
            self.assertEqual(raised.exception.reason_code, "owner_grant_permissions_too_open")

    @unittest.skipIf(os.name == "nt", "creating a symlink needs a privilege on Windows")
    def test_symlink_expired_target_mismatch_and_long_ttl_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            grant = root / "grant.json"
            link = root / "grant-link.json"
            _write_grant(grant)
            link.symlink_to(grant)
            with self.assertRaises(AppControlError):
                load_owner_grant(link, target_bundle_id=TARGET, now_epoch=NOW)
            with self.assertRaises(AppControlError) as raised:
                load_owner_grant(grant, target_bundle_id="com.example.Other", now_epoch=NOW)
            self.assertEqual(raised.exception.reason_code, "grant_target_mismatch")

            _write_grant(grant, now=NOW - 500)
            with self.assertRaises(AppControlError) as raised:
                load_owner_grant(grant, target_bundle_id=TARGET, now_epoch=NOW)
            self.assertEqual(raised.exception.reason_code, "grant_expired")

            value = json.loads(grant.read_text(encoding="utf-8"))
            value["issued_at"] = _iso(NOW - 1)
            value["expires_at"] = _iso(NOW + 301)
            grant.write_text(json.dumps(value), encoding="utf-8")
            grant.chmod(0o600)
            with self.assertRaises(AppControlError) as raised:
                load_owner_grant(grant, target_bundle_id=TARGET, now_epoch=NOW)
            self.assertEqual(raised.exception.reason_code, "grant_ttl_invalid")


@unittest.skipUnless(_temp_dir_is_private(), "temporary directories are not private here")
class AppControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._controllers: list[AppController] = []

    @contextlib.contextmanager
    def scratch(self):
        """A temp dir whose controllers are closed first: Windows cannot delete an open file."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            try:
                yield directory
            finally:
                for controller in self._controllers:
                    controller.close()
                self._controllers.clear()

    def _controller(
        self,
        root: Path,
        backend: FakeAppBackend,
        *,
        live: bool = True,
        mono: list[float] | None = None,
        max_events: int = 4,
    ) -> AppController:
        clock = mono or [100.0]
        controller = AppController(
            TARGET,
            live_opt_in=live,
            ttl_seconds=120,
            max_events=max_events,
            max_observation_age_ms=2_000,
            grant_path=root / "grant.json",
            receipt_path=root / "receipts.jsonl",
            backend=backend,
            monotonic=lambda: clock[0],
            wall_time=lambda: NOW,
        )
        self._controllers.append(controller)
        return controller

    def test_observe_then_one_bound_click_rotates_observation(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            _write_grant(root / "grant.json")
            backend = FakeAppBackend()
            controller = self._controller(root, backend)
            observed = controller.observe()
            receipt = controller.click(
                50, 60, observed["observation_id"], "Open the visible selected control."
            )
            self.assertTrue(receipt["ok"])
            self.assertTrue(receipt["host_input_fired"])
            self.assertEqual(receipt["events_used"], 1)
            self.assertNotEqual(receipt["next_observation_id"], observed["observation_id"])
            self.assertEqual(backend.calls[0]["kind"], "click")

            replay = controller.click(50, 60, observed["observation_id"], "Repeat the prior click.")
            self.assertFalse(replay["ok"])
            self.assertEqual(replay["reason_code"], "fresh_observation_required")
            self.assertEqual(len(backend.calls), 1)

    def test_cli_opt_in_and_owner_grant_are_independent_gates(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            _write_grant(root / "grant.json")
            backend = FakeAppBackend()
            controller = self._controller(root, backend, live=False)
            observed = controller.observe()
            receipt = controller.key(
                "enter", observed["observation_id"], "Confirm the selected dialog."
            )
            self.assertEqual(receipt["reason_code"], "cli_live_opt_in_required")
            self.assertFalse(receipt["host_input_fired"])
            self.assertEqual(backend.calls, [])

            (root / "grant.json").unlink()
            controller = self._controller(root, backend, live=True)
            observed = controller.observe()
            receipt = controller.key(
                "enter", observed["observation_id"], "Confirm the selected dialog."
            )
            self.assertEqual(receipt["reason_code"], "owner_grant_missing")
            self.assertEqual(backend.calls, [])

    def test_terminal_target_is_forbidden_even_with_an_injected_backend(self) -> None:
        backend = FakeAppBackend("com.apple.Terminal")
        with self.assertRaises(AppControlError) as raised:
            AppController("com.apple.Terminal", backend=backend)
        self.assertEqual(raised.exception.reason_code, "shell_app_target_forbidden")

    def test_dedicated_game_process_is_reserved_for_game_provider(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            _write_grant(root / "grant.json")
            backend = FakeAppBackend()
            backend.state["process"] = "wine64-preloader"
            controller = self._controller(root, backend)
            observed = controller.observe()
            receipt = controller.key(
                "z", observed["observation_id"], "Advance the visible game dialog."
            )
            self.assertEqual(receipt["reason_code"], "dedicated_game_driver_required")
            self.assertEqual(backend.calls, [])

    def test_target_change_stale_binding_and_pointer_escape_refuse(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            _write_grant(root / "grant.json")
            backend = FakeAppBackend()
            mono = [100.0]
            controller = self._controller(root, backend, mono=mono)
            observed = controller.observe()
            backend.state["pid"] = 43
            changed = controller.key(
                "a", observed["observation_id"], "Enter the advertised shortcut."
            )
            self.assertEqual(changed["reason_code"], "target_changed_since_observation")
            self.assertEqual(backend.calls, [])

            backend.state["pid"] = 42
            observed = controller.observe()
            outside = controller.click(
                900, 700, observed["observation_id"], "Select the visible item."
            )
            self.assertEqual(outside["reason_code"], "pointer_outside_target_window")
            self.assertEqual(backend.calls, [])

            observed = controller.observe()
            mono[0] += 2.1
            stale = controller.key(
                "tab", observed["observation_id"], "Move to the next visible field."
            )
            self.assertEqual(stale["reason_code"], "observation_stale")
            self.assertEqual(backend.calls, [])

    def test_focus_is_separate_and_nonfrontmost_input_refuses(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            _write_grant(root / "grant.json")
            backend = FakeAppBackend(frontmost=False)
            controller = self._controller(root, backend)
            observed = controller.observe()
            refused = controller.key("a", observed["observation_id"], "Use the app shortcut.")
            self.assertEqual(refused["reason_code"], "target_not_frontmost")
            focused = controller.focus(
                observed["observation_id"], "Focus the explicitly selected app."
            )
            self.assertTrue(focused["ok"])
            self.assertTrue(backend.state["frontmost"])
            self.assertEqual([call["kind"] for call in backend.calls], ["focus"])

    def test_typed_text_is_redacted_from_durable_receipt(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            _write_grant(root / "grant.json")
            backend = FakeAppBackend()
            controller = self._controller(root, backend)
            observed = controller.observe()
            secret = "fixture text that must not enter the effect receipt"
            receipt = controller.type_text(
                secret,
                observed["observation_id"],
                "Fill the visible field with the requested fixture value.",
            )
            self.assertTrue(receipt["typed_text_redacted"])
            self.assertNotIn(secret, json.dumps(receipt))
            controller.close()  # release the lease before a second handle reads the file
            durable = (root / "receipts.jsonl").read_text(encoding="utf-8")
            self.assertNotIn(secret, durable)
            self.assertIn("text_sha256", durable)

    def test_event_limit_and_changed_grant_fail_closed(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            grant = root / "grant.json"
            _write_grant(grant, max_events=1)
            backend = FakeAppBackend()
            controller = self._controller(root, backend, max_events=3)
            first = controller.observe()
            done = controller.key("a", first["observation_id"], "Use the visible app shortcut.")
            self.assertTrue(done["ok"])
            blocked = controller.key(
                "b", done["next_observation_id"], "Use another visible shortcut."
            )
            self.assertEqual(blocked["reason_code"], "owner_grant_event_limit_reached")

            _write_grant(grant, max_events=3, actions=["key"])
            changed = controller.key(
                "b", done["next_observation_id"], "Use another visible shortcut."
            )
            self.assertEqual(changed["reason_code"], "owner_grant_changed")
            self.assertEqual(len(backend.calls), 1)

    def test_one_cross_process_lease_and_aggregate_grant_budget(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            _write_grant(root / "grant.json", max_events=1)
            first_backend = FakeAppBackend()
            first = self._controller(root, first_backend, max_events=3)
            observed = first.observe()
            done = first.key("a", observed["observation_id"], "Use the visible shortcut.")
            self.assertTrue(done["ok"])

            second_backend = FakeAppBackend()
            second = self._controller(root, second_backend, max_events=3)
            observed = second.observe()
            busy = second.key("a", observed["observation_id"], "Use the visible shortcut.")
            self.assertEqual(busy["reason_code"], "receipt_store_busy")
            self.assertEqual(second_backend.calls, [])

            first.close()
            third_backend = FakeAppBackend()
            third = self._controller(root, third_backend, max_events=3)
            observed = third.observe()
            exhausted = third.key("a", observed["observation_id"], "Use the visible shortcut.")
            self.assertEqual(exhausted["reason_code"], "owner_grant_event_limit_reached")
            self.assertEqual(third_backend.calls, [])
            third.close()

    def test_post_effect_receipt_failure_is_ambiguous_and_not_retryable(self) -> None:
        with self.scratch() as temporary:
            root = Path(temporary)
            _write_grant(root / "grant.json")
            backend = FakeAppBackend()
            controller = self._controller(root, backend)
            observed = controller.observe()
            calls = [0]
            real_fsync = os.fsync

            def fail_second_fsync(descriptor):
                calls[0] += 1
                if calls[0] == 2:
                    raise OSError("fixture fsync failure")
                return real_fsync(descriptor)

            with patch("alcor_computer.app_control.os.fsync", side_effect=fail_second_fsync):
                receipt = controller.key(
                    "a", observed["observation_id"], "Use the visible shortcut."
                )
            self.assertEqual(receipt["reason_code"], "effect_outcome_ambiguous")
            self.assertFalse(receipt["ok"])
            self.assertFalse(receipt["retryable"])
            self.assertIsNone(receipt["host_input_fired"])
            self.assertEqual(len(backend.calls), 1)
            again = controller.observe()
            held = controller.key("b", again["observation_id"], "Use another visible shortcut.")
            self.assertEqual(held["reason_code"], "prior_effect_outcome_ambiguous")
            self.assertEqual(len(backend.calls), 1)


if __name__ == "__main__":
    unittest.main()
