import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from syncplan import plan, scan  # noqa: E402


def write(root, rel, text, mtime):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)
    os.utime(path, ns=(mtime, mtime))


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.tmp.name, "src")
        self.dst = os.path.join(self.tmp.name, "dst")
        write(self.src, "a.txt", "aaa", 2_000_000_000)
        write(self.src, "sub/b.txt", "b", 2_000_000_000)
        write(self.src, "same.txt", "s", 1_000_000_000)
        write(self.dst, "a.txt", "aaa", 1_000_000_000)
        write(self.dst, "same.txt", "s", 1_000_000_000)
        write(self.dst, "old.txt", "o", 1_000_000_000)

    def tearDown(self):
        self.tmp.cleanup()

    def test_scan(self):
        self.assertEqual(sorted(scan(self.src)), ["a.txt", "same.txt", "sub/b.txt"])

    def test_plan(self):
        self.assertEqual(plan(self.src, self.dst), [("update", "a.txt"), ("copy", "sub/b.txt")])
        self.assertIn(("delete", "old.txt"), plan(self.src, self.dst, delete=True))

    def test_cli(self):
        out = subprocess.run([sys.executable, "-m", "syncplan", self.src, self.dst], cwd=ROOT,
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(out.stdout, "update a.txt\ncopy sub/b.txt\n")


if __name__ == "__main__":
    unittest.main()
