"""Route validated events to the handlers that keep the order ledger up to date."""
from .validate import SchemaError, validate


class Ledger:
    def __init__(self):
        self.orders = {}

    def get(self, order_id):
        if order_id not in self.orders:
            raise SchemaError("unknown order: %s" % order_id)
        return self.orders[order_id]


def on_placed(payload, ledger):
    ledger.orders[payload["order_id"]] = {"status": "placed", "total_cents": payload["total_cents"],
                                          "paid_cents": 0}


def on_paid(payload, ledger):
    order = ledger.get(payload["order_id"])
    order["paid_cents"] += payload["amount_cents"]
    order["status"] = "paid" if order["paid_cents"] >= order["total_cents"] else "partially_paid"


def on_shipped(payload, ledger):
    order = ledger.get(payload["order_id"])
    order["status"] = "shipped"
    order["carrier"] = payload["carrier"]


# Old event names still sent by producers we don't control yet -> current names.
LEGACY_NAMES = {"payment_received": "order.paid"}

HANDLERS = {
    "order.placed": [on_placed],
    "order.paid": [on_paid],
    "order.shipped": [on_shipped],
}


def dispatch(event, ledger):
    """Validate `event`, then run every handler registered for its name.

    Events still using a legacy name are accepted and treated as the current name.
    """
    if isinstance(event, dict) and event.get("event") in LEGACY_NAMES:
        event = dict(event, event=LEGACY_NAMES[event["event"]])
    validate(event)
    for handler in HANDLERS.get(event["event"], []):
        handler(event["payload"], ledger)
