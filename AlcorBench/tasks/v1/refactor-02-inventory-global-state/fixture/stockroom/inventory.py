"""Stock levels per SKU, plus a history of every movement."""

_levels = {}
_history = []


class InsufficientStock(ValueError):
    pass


def _check(sku, qty):
    if not sku or not isinstance(sku, str):
        raise ValueError("sku must be a non-empty string")
    if not isinstance(qty, int) or qty <= 0:
        raise ValueError("quantity must be a positive integer")


def reset():
    _levels.clear()
    _history.clear()


def receive(sku, qty):
    """Add stock. Returns the new level."""
    _check(sku, qty)
    _levels[sku] = _levels.get(sku, 0) + qty
    _history.append(("receive", sku, qty))
    return _levels[sku]


def ship(sku, qty):
    """Remove stock. Raises InsufficientStock if there is not enough."""
    _check(sku, qty)
    have = _levels.get(sku, 0)
    if qty > have:
        raise InsufficientStock(f"{sku}: have {have}, need {qty}")
    _levels[sku] = have - qty
    _history.append(("ship", sku, qty))
    return _levels[sku]


def level(sku):
    return _levels.get(sku, 0)


def all_levels():
    """{sku: level} sorted by SKU (a new dict; changing it has no effect)."""
    return dict(sorted(_levels.items()))


def history():
    return list(_history)


def load_state(data):
    """Replace the current state with ``data`` from dump_state()."""
    reset()
    _levels.update({sku: int(n) for sku, n in data.get("levels", {}).items()})
    _history.extend(tuple(h) for h in data.get("history", []))


def dump_state():
    return {"levels": dict(sorted(_levels.items())), "history": [list(h) for h in _history]}
