"""The shared runtime is dry-run by default and arms are process-local."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from alcor_computer.runtime import Computer, RuntimeErrorCode


class FakeBackend:
    name = "fake"

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def status(self):
        return {"ok": True, "backend": self.name, "capabilities": ["observe"]}

    def screen_size(self):
        return (1280, 720)

    def foreground_window(self):
        return {"title": "fixture", "process": "fixture"}

    def screenshot(self, path: str):
        return {"ok": True, "path": path, "format": "png"}

    def perform(self, action):
        self.calls.append(dict(action))


class SharedRuntimeTests(unittest.TestCase):
    def test_custom_backend_hook_and_normalized_status(self) -> None:
        computer = Computer(FakeBackend())
        status = computer.status()
        self.assertTrue(status["ok"])
        self.assertEqual(status["platform"], "fake")
        self.assertTrue(status["shared_interface"])
        self.assertTrue(status["dry_run_default"])

    def test_observe_shape_is_platform_independent(self) -> None:
        computer = Computer(FakeBackend())
        with tempfile.TemporaryDirectory() as temporary:
            receipt = computer.observe(screenshot_path=str(Path(temporary) / "screen.png"))
        self.assertTrue(receipt["ok"])
        self.assertEqual(receipt["screen"], {"width": 1280, "height": 720})
        self.assertFalse(receipt["host_input_fired"])

    def test_execute_is_dry_run_by_default(self) -> None:
        backend = FakeBackend()
        computer = Computer(backend)
        receipt = computer.execute("click", x=10, y=20)
        self.assertTrue(receipt["ok"])
        self.assertEqual(receipt["reason_code"], "dry_run")
        self.assertEqual(backend.calls, [])

    def test_live_execution_requires_process_local_arm(self) -> None:
        backend = FakeBackend()
        computer = Computer(backend)
        denied = computer.execute("click", x=10, y=20, dry_run=False)
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["reason_code"], "not_armed")
        session = computer.arm({"click"}, ttl_seconds=30)
        allowed = computer.execute("click", x=10, y=20, dry_run=False, session=session)
        self.assertTrue(allowed["ok"])
        self.assertTrue(allowed["host_input_fired"])
        self.assertEqual(len(backend.calls), 1)

    def test_arm_cannot_cross_computer_instances(self) -> None:
        first = Computer(FakeBackend())
        second = Computer(FakeBackend())
        session = first.arm({"click"})
        receipt = second.execute("click", x=1, y=1, dry_run=False, session=session)
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["reason_code"], "not_armed")

    def test_action_shapes_fail_closed(self) -> None:
        computer = Computer(FakeBackend())
        with self.assertRaises(RuntimeErrorCode):
            computer.plan("shell", command="anything")
        with self.assertRaises(RuntimeErrorCode):
            computer.plan("click", x=-1, y=0)
        with self.assertRaises(RuntimeErrorCode):
            computer.plan("click", x=1, y=1, button="right")

    def test_unsupported_platform_fails_closed(self) -> None:
        with self.assertRaises(RuntimeErrorCode):
            Computer(platform_name="unsupported-test-platform")


if __name__ == "__main__":
    unittest.main()
