import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from orders import Ledger, SchemaError, dispatch, validate  # noqa: E402
from orders import events  # noqa: E402


class FlowTests(unittest.TestCase):
    def test_full_lifecycle(self):
        ledger = Ledger()
        dispatch(events.order_placed("o-1", 3000), ledger)
        dispatch(events.payment_received("o-1", 1000, "card"), ledger)
        self.assertEqual(ledger.orders["o-1"]["status"], "partially_paid")
        dispatch(events.payment_received("o-1", 2000, "card"), ledger)
        self.assertEqual(ledger.orders["o-1"]["status"], "paid")
        dispatch(events.order_shipped("o-1", "DHL"), ledger)
        self.assertEqual(ledger.orders["o-1"]["status"], "shipped")

    def test_emitted_events_are_valid(self):
        for event in [events.order_placed("o", 1), events.payment_received("o", 1, "cash"),
                      events.order_shipped("o", "UPS")]:
            validate(event)

    def test_rejects_bad_payload(self):
        bad = events.order_placed("o", 1)
        bad["payload"]["total_cents"] = "1"
        with self.assertRaises(SchemaError):
            validate(bad)

    def test_unknown_event(self):
        with self.assertRaises(SchemaError):
            dispatch({"event": "order.lost", "version": 1, "payload": {}}, Ledger())


if __name__ == "__main__":
    unittest.main()
