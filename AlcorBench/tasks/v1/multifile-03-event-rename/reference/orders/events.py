"""Build order events. Producers call these instead of writing dicts by hand."""

VERSION = 1


def make_event(name, payload):
    return {"event": name, "version": VERSION, "payload": dict(payload)}


def order_placed(order_id, total_cents):
    return make_event("order.placed", {"order_id": order_id, "total_cents": total_cents})


def payment_received(order_id, amount_cents, method):
    return make_event("order.paid",
                      {"order_id": order_id, "amount_cents": amount_cents, "method": method})


def order_shipped(order_id, carrier):
    return make_event("order.shipped", {"order_id": order_id, "carrier": carrier})
