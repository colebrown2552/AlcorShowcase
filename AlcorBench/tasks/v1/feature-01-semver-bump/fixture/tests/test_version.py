import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from semverlite import compare, parse  # noqa: E402


class ParseTests(unittest.TestCase):
    def test_parse_full(self):
        v = parse("2.10.3-beta.1+sha.5114f85")
        self.assertEqual((v.major, v.minor, v.patch), (2, 10, 3))
        self.assertEqual(v.prerelease, "beta.1")
        self.assertEqual(v.build, "sha.5114f85")

    def test_round_trip(self):
        for text in ["0.0.1", "1.2.3-rc.1", "4.5.6+exp", "7.8.9-x.7.z.92+meta"]:
            self.assertEqual(str(parse(text)), text)

    def test_rejects_garbage(self):
        for text in ["1.2", "01.2.3", "1.2.3-", "v1.2.3"]:
            with self.assertRaises(ValueError):
                parse(text)


class CompareTests(unittest.TestCase):
    def test_order(self):
        chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-beta.2",
                 "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"]
        for lo, hi in zip(chain, chain[1:]):
            self.assertEqual(compare(parse(lo), parse(hi)), -1, (lo, hi))
            self.assertEqual(compare(parse(hi), parse(lo)), 1, (hi, lo))

    def test_build_ignored(self):
        self.assertEqual(compare(parse("1.0.0+a"), parse("1.0.0+b")), 0)


if __name__ == "__main__":
    unittest.main()
