"""Command line: init/append/verify round trip, failing scans, and the no-install launcher."""

from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from continuity_core.cli import main

COMPONENT_ROOT = Path(__file__).resolve().parents[1]


class CliTests(unittest.TestCase):
    def test_init_append_and_verify(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                self.assertEqual(main(["init", str(root)]), 0)
            ledger = root / "wishlist" / "public.jsonl"
            self.assertTrue(ledger.exists())

            with redirect_stdout(io.StringIO()):
                self.assertEqual(
                    main(
                        [
                            "append",
                            str(ledger),
                            "--kind",
                            "wishlist",
                            "--statement",
                            "Add a synthetic verification fixture.",
                            "--provenance",
                            "test",
                        ]
                    ),
                    0,
                )
                self.assertEqual(main(["verify", str(ledger)]), 0)

    def test_scan_missing_path_fails(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            result = main(["scan", "path-that-does-not-exist"])
        self.assertEqual(result, 1)
        self.assertIn("path-does-not-exist", stderr.getvalue())

    def test_no_install_entrypoint(self) -> None:
        # PYTHONPATH is removed so only the launcher's own path set-up can find the package.
        process = subprocess.run(
            [
                sys.executable,
                str(COMPONENT_ROOT / "continuity.py"),
                "verify",
                str(COMPONENT_ROOT / "examples" / "principles.jsonl"),
            ],
            cwd=COMPONENT_ROOT,
            env={key: value for key, value in os.environ.items() if key.upper() != "PYTHONPATH"},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn('"ok": true', process.stdout)


if __name__ == "__main__":
    unittest.main()
