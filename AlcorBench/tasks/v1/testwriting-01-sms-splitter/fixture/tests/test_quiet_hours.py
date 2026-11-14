import unittest
from datetime import time

from notify.quiet_hours import in_quiet_hours


class QuietHoursTests(unittest.TestCase):
    def test_window_wrapping_midnight(self):
        self.assertTrue(in_quiet_hours(time(23, 30)))
        self.assertTrue(in_quiet_hours(time(6, 59)))
        self.assertFalse(in_quiet_hours(time(7, 0)))

    def test_daytime_window(self):
        self.assertTrue(in_quiet_hours(time(13, 0), start=time(12, 0), end=time(14, 0)))
        self.assertFalse(in_quiet_hours(time(14, 0), start=time(12, 0), end=time(14, 0)))

    def test_empty_window(self):
        self.assertFalse(in_quiet_hours(time(3, 0), start=time(5, 0), end=time(5, 0)))


if __name__ == "__main__":
    unittest.main()
