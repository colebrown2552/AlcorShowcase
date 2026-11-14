import unittest

from cronlite.durations import parse_duration


class ParseDurationTest(unittest.TestCase):
    def test_examples(self):
        self.assertEqual(parse_duration("90s"), 90)
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("2d"), 172800)
        self.assertEqual(parse_duration("45"), 45)

    def test_rejects_unknown_unit(self):
        with self.assertRaises(ValueError) as ctx:
            parse_duration("3w")
        self.assertEqual(str(ctx.exception), "invalid duration: '3w'")


if __name__ == "__main__":
    unittest.main()
