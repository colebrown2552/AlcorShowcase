import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "logstat.py")
LOG = """2026-03-01T10:00:00 INFO started
2026-03-01T10:00:01 ERROR disk full
2026-03-01T10:00:02 INFO retry
not a log line
"""


def run(*args):
    return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=10)


class LogstatTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".log")
        with os.fdopen(fd, "w") as handle:
            handle.write(LOG)

    def tearDown(self):
        os.remove(self.path)

    def test_counts(self):
        out = run(self.path)
        self.assertEqual(out.returncode, 0)
        self.assertEqual(out.stdout, "INFO 2\nERROR 1\n")

    def test_level(self):
        self.assertEqual(run(self.path, "--level", "WARNING").stdout, "WARNING 0\n")

    def test_missing_file(self):
        out = run(self.path + ".nope")
        self.assertEqual(out.returncode, 2)
        self.assertEqual(out.stdout, "")
        self.assertIn("cannot read", out.stderr)


if __name__ == "__main__":
    unittest.main()
