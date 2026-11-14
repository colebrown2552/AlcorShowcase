import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from roomcal import Booking, bookings_for, conflicts, from_minutes, to_minutes  # noqa: E402


class ClockTests(unittest.TestCase):
    def test_round_trip(self):
        for text in ["00:00", "07:05", "23:59", "24:00"]:
            self.assertEqual(from_minutes(to_minutes(text)), text)

    def test_rejects(self):
        for text in ["7:05", "24:01", "12:60", ""]:
            with self.assertRaises(ValueError):
                to_minutes(text)


class CalendarTests(unittest.TestCase):
    def test_booking_must_have_length(self):
        with self.assertRaises(ValueError):
            Booking("Atlas", "10:00", "10:00")

    def test_conflicts(self):
        a = Booking("Atlas", "09:00", "10:00")
        b = Booking("Atlas", "09:30", "11:00")
        c = Booking("Atlas", "11:00", "12:00")
        d = Booking("Borealis", "09:00", "10:00")
        self.assertEqual(conflicts([c, d, b, a]), [(a, b)])
        self.assertEqual(bookings_for([c, d, b, a], "Atlas"), [a, b, c])


if __name__ == "__main__":
    unittest.main()
