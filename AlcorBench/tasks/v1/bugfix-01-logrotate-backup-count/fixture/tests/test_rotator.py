import os
import tempfile
import unittest

from logrot.rotator import append_line, rotate, should_rotate


class RotatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "app.log")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, text):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write(text)

    def read(self, path):
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    def test_first_rotation_creates_backup_one(self):
        self.write("hello\n")
        rotate(self.path, 3)
        self.assertEqual(self.read(self.path + ".1"), "hello\n")
        self.assertEqual(self.read(self.path), "")

    def test_zero_backups_truncates(self):
        self.write("hello\n")
        rotate(self.path, 0)
        self.assertEqual(self.read(self.path), "")
        self.assertFalse(os.path.exists(self.path + ".1"))

    def test_missing_file_is_ignored(self):
        rotate(self.path, 3)
        self.assertFalse(os.path.exists(self.path))

    def test_should_rotate_on_size(self):
        self.write("x" * 10)
        self.assertTrue(should_rotate(self.path, 10))
        self.assertFalse(should_rotate(self.path, 11))

    def test_append_line_rotates_when_full(self):
        append_line(self.path, "aaaa", max_bytes=5, backup_count=2)
        append_line(self.path, "bbbb", max_bytes=5, backup_count=2)
        self.assertEqual(self.read(self.path), "bbbb\n")
        self.assertEqual(self.read(self.path + ".1"), "aaaa\n")


if __name__ == "__main__":
    unittest.main()
