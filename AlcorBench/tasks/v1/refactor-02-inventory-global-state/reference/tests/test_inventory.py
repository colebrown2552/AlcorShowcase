import unittest

from stockroom import report
from stockroom.inventory import InsufficientStock, Inventory


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.inv = Inventory()

    def test_receive_and_ship(self):
        self.assertEqual(self.inv.receive("BOLT-M6", 100), 100)
        self.assertEqual(self.inv.ship("BOLT-M6", 30), 70)
        self.assertEqual(self.inv.level("BOLT-M6"), 70)
        self.assertEqual(self.inv.level("NUT-M6"), 0)

    def test_insufficient(self):
        self.inv.receive("WASHER", 2)
        with self.assertRaises(InsufficientStock):
            self.inv.ship("WASHER", 3)
        self.assertEqual(self.inv.level("WASHER"), 2)

    def test_bad_quantity(self):
        with self.assertRaises(ValueError):
            self.inv.receive("WASHER", 0)

    def test_state_roundtrip(self):
        self.inv.receive("A", 5)
        self.inv.ship("A", 1)
        restored = Inventory.from_dict(self.inv.to_dict())
        self.assertEqual(restored.level("A"), 4)
        self.assertEqual(restored.history(), [("receive", "A", 5), ("ship", "A", 1)])

    def test_instances_are_independent(self):
        other = Inventory()
        self.inv.receive("A", 5)
        self.assertEqual(other.level("A"), 0)

    def test_low_stock_report(self):
        self.inv.receive("A", 3)
        self.inv.receive("B", 50)
        self.inv.receive("C", 1)
        self.assertEqual(report.low_stock_report(self.inv, 5),
                         "2 of 3 SKUs at or below 5:\n  C                1\n  A                3")


if __name__ == "__main__":
    unittest.main()
