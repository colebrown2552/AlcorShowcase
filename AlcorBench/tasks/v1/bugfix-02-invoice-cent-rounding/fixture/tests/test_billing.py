import unittest

from billing.invoice import Invoice
from billing.money import format_cents, parse_amount


class MoneyTests(unittest.TestCase):
    def test_plain_and_formatted(self):
        self.assertEqual(parse_amount("12.50"), 1250)
        self.assertEqual(parse_amount("$1,200.00"), 120000)
        self.assertEqual(parse_amount("7"), 700)

    def test_negative_forms(self):
        self.assertEqual(parse_amount("-3.00"), -300)
        self.assertEqual(parse_amount("(3.00)"), -300)

    def test_rejects_garbage(self):
        for bad in ("", "abc", "$", "--1"):
            with self.assertRaises(ValueError):
                parse_amount(bad)

    def test_format(self):
        self.assertEqual(format_cents(123456), "1,234.56")
        self.assertEqual(format_cents(-5), "-0.05")


class InvoiceTests(unittest.TestCase):
    def test_totals_with_tax(self):
        inv = Invoice("A-1", tax_basis_points=1000)
        inv.add_line("Widget", "10.00", 3)
        inv.add_line("Gadget", "2.50", 2)
        self.assertEqual(inv.subtotal_cents(), 3500)
        self.assertEqual(inv.tax_cents(), 350)
        self.assertEqual(inv.total_cents(), 3850)


if __name__ == "__main__":
    unittest.main()
