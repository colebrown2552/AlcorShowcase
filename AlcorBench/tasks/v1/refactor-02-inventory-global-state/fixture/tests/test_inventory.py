import unittest

from stockroom import inventory, report


class InventoryTests(unittest.TestCase):
    def setUp(self):
        inventory.reset()

    def test_receive_and_ship(self):
        self.assertEqual(inventory.receive("BOLT-M6", 100), 100)
        self.assertEqual(inventory.ship("BOLT-M6", 30), 70)
        self.assertEqual(inventory.level("BOLT-M6"), 70)
        self.assertEqual(inventory.level("NUT-M6"), 0)

    def test_insufficient(self):
        inventory.receive("WASHER", 2)
        with self.assertRaises(inventory.InsufficientStock):
            inventory.ship("WASHER", 3)
        self.assertEqual(inventory.level("WASHER"), 2)

    def test_bad_quantity(self):
        with self.assertRaises(ValueError):
            inventory.receive("WASHER", 0)

    def test_state_roundtrip(self):
        inventory.receive("A", 5)
        inventory.ship("A", 1)
        state = inventory.dump_state()
        inventory.reset()
        inventory.load_state(state)
        self.assertEqual(inventory.level("A"), 4)
        self.assertEqual(inventory.history(), [("receive", "A", 5), ("ship", "A", 1)])

    def test_low_stock_report(self):
        inventory.receive("A", 3)
        inventory.receive("B", 50)
        inventory.receive("C", 1)
        self.assertEqual(report.low_stock_report(5),
                         "2 of 3 SKUs at or below 5:\n  C                1\n  A                3")


if __name__ == "__main__":
    unittest.main()
