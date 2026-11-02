"""Backends hold no hidden input path: static scan and raise-only seams."""

from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from alcor_computer.backends.base import BackendError
from alcor_computer.backends.macos import MacOSBackend


def _raise_only_method(tree: ast.AST, class_name: str, method_name: str) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == method_name:
                    body = list(item.body)
                    if (
                        body
                        and isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and isinstance(body[0].value.value, str)
                    ):
                        body = body[1:]
                    return len(body) == 1 and isinstance(body[0], ast.Raise)
    return False


class BackendAuthorityTests(unittest.TestCase):
    def test_macos_screenshot_is_disabled_without_filesystem_effect(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "screen.png"
            with (
                patch("alcor_computer.backends.macos.platform.system", return_value="Darwin"),
                self.assertRaises(BackendError) as raised,
            ):
                MacOSBackend().screenshot(str(target))
            self.assertEqual(str(raised.exception), "screenshot_capture_not_enabled")
            self.assertFalse(target.exists())

    def test_package_scan_recurses_and_built_in_input_seams_raise_only(self) -> None:
        root = Path(__file__).resolve().parents[1]
        paths = sorted(root.rglob("*.py"))
        banned_imports = {
            "keyboard",
            "mouse",
            "pyautogui",
            "pynput",
            "requests",
            "socket",
            "urllib",
        }
        violations: set[str] = set()
        for path in paths:
            relative = path.relative_to(root).as_posix()
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=relative)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    roots = {alias.name.split(".", 1)[0] for alias in node.names}
                    if roots & banned_imports:
                        violations.add(relative)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    if node.module.split(".", 1)[0] in banned_imports:
                        violations.add(relative)
            if relative == "backends/macos.py" and not _raise_only_method(
                tree, "MacOSBackend", "perform"
            ):
                violations.add(relative)
            if relative == "backends/windows.py" and not _raise_only_method(
                tree, "WindowsBackend", "perform"
            ):
                violations.add(relative)

        self.assertGreaterEqual(len(paths), 10)
        self.assertEqual(violations, set())


if __name__ == "__main__":
    unittest.main()
