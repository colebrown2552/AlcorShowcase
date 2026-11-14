import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "envtool.py")


def run(path, *args):
    return subprocess.run([sys.executable, SCRIPT, "--file", path, *args],
                          capture_output=True, text=True, timeout=10)


class EnvtoolTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, ".env")
        with open(self.path, "w") as handle:
            handle.write("# app\nexport HOST=localhost\n\nPORT=80\nPORT = 8080\n")

    def tearDown(self):
        self.dir.cleanup()

    def test_get_last_wins(self):
        self.assertEqual(run(self.path, "get", "PORT").stdout, "8080\n")
        self.assertEqual(run(self.path, "get", "HOST").stdout, "localhost\n")

    def test_get_missing(self):
        out = run(self.path, "get", "NOPE")
        self.assertEqual((out.returncode, out.stdout), (1, ""))
        self.assertIn("no such key: NOPE", out.stderr)

    def test_set_keeps_layout(self):
        self.assertEqual(run(self.path, "set", "DEBUG", "1").returncode, 0)
        with open(self.path) as handle:
            self.assertEqual(handle.read(),
                             "# app\nexport HOST=localhost\n\nPORT=80\nPORT = 8080\nDEBUG=1\n")

    def test_invalid_key(self):
        out = run(self.path, "set", "9X", "1")
        self.assertEqual(out.returncode, 2)


if __name__ == "__main__":
    unittest.main()
