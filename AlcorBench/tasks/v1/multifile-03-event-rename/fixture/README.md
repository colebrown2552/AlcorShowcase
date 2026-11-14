# orders

Order lifecycle events for the shop backend.

- `orders/events.py` builds events (`{"event": NAME, "version": 1, "payload": {...}}`).
- `orders/schema/events.json` is the published contract for every event name and
  its payload fields; other services generate their validators from it.
- `orders/validate.py` checks an event against that schema.
- `orders/handlers.py` routes validated events to the handlers that update the ledger.
