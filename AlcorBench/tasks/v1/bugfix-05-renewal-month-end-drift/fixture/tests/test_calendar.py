import unittest
from datetime import date

from subs.billing import annual_cost_cents, upcoming_charges
from subs.calendar_utils import add_months
from subs.plans import MONTHLY, QUARTERLY, YEARLY


class AddMonthsTests(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(add_months(date(2025, 3, 15), 1), date(2025, 4, 15))

    def test_clamps_short_month(self):
        self.assertEqual(add_months(date(2025, 1, 31), 1), date(2025, 2, 28))
        self.assertEqual(add_months(date(2024, 1, 31), 1), date(2024, 2, 29))

    def test_year_rollover(self):
        self.assertEqual(add_months(date(2025, 11, 10), 3), date(2026, 2, 10))


class BillingTests(unittest.TestCase):
    def test_upcoming_mid_month(self):
        self.assertEqual(
            upcoming_charges(date(2025, 5, 12), MONTHLY, 2),
            [("2025-06-12", 1200), ("2025-07-12", 1200)],
        )

    def test_annual_cost(self):
        self.assertEqual(annual_cost_cents(QUARTERLY), 13200)
        self.assertEqual(annual_cost_cents(YEARLY), 12000)


if __name__ == "__main__":
    unittest.main()
