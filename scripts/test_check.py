"""Self-tests for scripts/check.py: statuses, counts, JSON output and the per-step timeout."""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True
import check  # noqa: E402

PY = "{python}"


def step(code: str, **extra) -> dict:
    return {"name": "s", "run": [PY, "-c", code], **extra}


class RunStepTests(unittest.TestCase):
    def test_pass_and_fail_statuses(self):
        self.assertEqual(check.run_step("C", step("pass"))[0], "pass")
        self.assertEqual(check.run_step("C", step("raise SystemExit(3)"))[0], "fail")

    def test_missing_tool_is_skip_only_when_optional(self):
        missing = {"name": "m", "run": ["alcor-no-such-tool-xyz"]}
        self.assertEqual(check.run_step("C", missing)[0], "fail")
        self.assertEqual(check.run_step("C", {**missing, "optional": True})[0], "skip")

    def test_timeout_kills_the_whole_process_group(self):
        with tempfile.TemporaryDirectory() as td:
            marker = Path(td) / "child-survived"
            child = f"import time, pathlib; time.sleep(3); pathlib.Path({str(marker)!r}).write_text('x')"
            code = f"import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(30)"
            started = time.monotonic()
            status, seconds = check.run_step("C", step(code, timeout=1))
            self.assertEqual(status, "timeout")
            self.assertLess(time.monotonic() - started, 10)
            time.sleep(4)
            self.assertFalse(marker.exists(), "the child process outlived the timeout")

    def test_counts_treat_timeout_as_failure(self):
        rows = [("C", "a", "pass", 0.1), ("C", "b", "timeout", 1.0), ("C", "c", "skip", 0.0), ("C", "d", "fail", 0.2)]
        self.assertEqual(check.summarize(rows), {"pass": 1, "fail": 2, "skip": 1})

    def test_root_comes_from_the_file_not_the_cwd(self):
        self.assertEqual(check.ROOT, Path(check.__file__).resolve().parent.parent)


class MainTests(unittest.TestCase):
    def test_json_output_has_strict_flag_counts_and_steps(self):
        with tempfile.TemporaryDirectory() as td:
            manifest = Path(td) / "checks.json"
            manifest.write_text(json.dumps({"Comp": [step("pass")]}))
            out = Path(td) / "out.json"
            original = check.MANIFEST
            check.MANIFEST = manifest
            try:
                rc = check.main(["--strict", "--json", str(out)])
            finally:
                check.MANIFEST = original
            data = json.loads(out.read_text())
            self.assertEqual(rc, 0)
            self.assertIs(data["strict"], True)
            self.assertEqual(data["counts"], {"pass": 1, "fail": 0, "skip": 0})
            self.assertEqual(data["steps"][0]["status"], "pass")


if __name__ == "__main__":
    unittest.main()
