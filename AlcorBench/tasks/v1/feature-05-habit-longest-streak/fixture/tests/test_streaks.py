import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from habits import Streak, current_streak, parse_journal  # noqa: E402

D = datetime.date


class JournalTests(unittest.TestCase):
    def test_parse(self):
        done = parse_journal("# march\n2026-03-01 stretch\n\n2026-03-02 stretch\n2026-03-02 read 20 pages\n")
        self.assertEqual(done["stretch"], {D(2026, 3, 1), D(2026, 3, 2)})
        self.assertEqual(done["read 20 pages"], {D(2026, 3, 2)})

    def test_bad_line(self):
        with self.assertRaises(ValueError):
            parse_journal("yesterday stretch\n")


class CurrentStreakTests(unittest.TestCase):
    def test_alive_through_today(self):
        days = [D(2026, 3, 3), D(2026, 3, 1), D(2026, 3, 2)]
        self.assertEqual(current_streak(days, D(2026, 3, 3)), Streak(3, D(2026, 3, 1), D(2026, 3, 3)))

    def test_alive_until_yesterday(self):
        self.assertEqual(current_streak([D(2026, 3, 2)], D(2026, 3, 3)).length, 1)

    def test_broken(self):
        self.assertFalse(current_streak([D(2026, 3, 1)], D(2026, 3, 3)))


if __name__ == "__main__":
    unittest.main()
