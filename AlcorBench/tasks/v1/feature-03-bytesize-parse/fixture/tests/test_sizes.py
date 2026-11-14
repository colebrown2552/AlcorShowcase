import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sizes import format_size  # noqa: E402


class FormatTests(unittest.TestCase):
    def test_decimal(self):
        self.assertEqual(format_size(0), "0 B")
        self.assertEqual(format_size(999), "999 B")
        self.assertEqual(format_size(1500), "1.5 kB")
        self.assertEqual(format_size(2_000_000_000), "2.0 GB")

    def test_binary(self):
        self.assertEqual(format_size(1536, binary=True), "1.5 KiB")
        self.assertEqual(format_size(3 * 2**40, binary=True), "3.0 TiB")

    def test_negative(self):
        with self.assertRaises(ValueError):
            format_size(-1)


if __name__ == "__main__":
    unittest.main()
