All our order events are named `order.<something>` except one: the payment event is still called `payment_received`. Please rename that event to **`order.paid`** everywhere in the `orders` package.

The name lives in three places that must agree:

- `orders/events.py`: `payment_received(...)` must emit events named `order.paid`. Keep the Python function name and its arguments as they are; only the event name changes. The payload fields stay the same.
- `orders/schema/events.json`: the published contract. It must list `order.paid` (same description and payload fields as before) and must no longer list `payment_received`. Keep the file valid JSON with the same structure.
- `orders/handlers.py`: the handlers that ran for `payment_received` must run for `order.paid`.

**Compatibility.** The billing service will keep sending events named `payment_received` for a few more weeks. `dispatch()` must still accept them: such an event is handled exactly as if it were named `order.paid` (validated against the `order.paid` schema entry, then the same handlers run once). This translation belongs in `dispatch` only: `validate()` checks strictly against the schema, so `validate()` of an event named `payment_received` raises `SchemaError`. Don't modify the caller's event dict.

Everything else (the other events, error behaviour for unknown events and bad payloads, the ledger) stays as it is. `tests/test_flow.py` must keep passing without changes, and there should be no remaining use of the old event name except the compatibility mapping in `dispatch`.
