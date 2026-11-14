"""Stock levels per SKU, plus a history of every movement."""


class InsufficientStock(ValueError):
    pass


def _check(sku, qty):
    if not sku or not isinstance(sku, str):
        raise ValueError("sku must be a non-empty string")
    if not isinstance(qty, int) or qty <= 0:
        raise ValueError("quantity must be a positive integer")


class Inventory:
    def __init__(self):
        self._levels = {}
        self._history = []

    def receive(self, sku, qty):
        """Add stock. Returns the new level."""
        _check(sku, qty)
        self._levels[sku] = self._levels.get(sku, 0) + qty
        self._history.append(("receive", sku, qty))
        return self._levels[sku]

    def ship(self, sku, qty):
        """Remove stock. Raises InsufficientStock if there is not enough."""
        _check(sku, qty)
        have = self._levels.get(sku, 0)
        if qty > have:
            raise InsufficientStock(f"{sku}: have {have}, need {qty}")
        self._levels[sku] = have - qty
        self._history.append(("ship", sku, qty))
        return self._levels[sku]

    def level(self, sku):
        return self._levels.get(sku, 0)

    def all_levels(self):
        """{sku: level} sorted by SKU (a new dict; changing it has no effect)."""
        return dict(sorted(self._levels.items()))

    def history(self):
        return list(self._history)

    @classmethod
    def from_dict(cls, data):
        """Build an inventory from the output of to_dict()."""
        inv = cls()
        inv._levels.update({sku: int(n) for sku, n in data.get("levels", {}).items()})
        inv._history.extend(tuple(h) for h in data.get("history", []))
        return inv

    def to_dict(self):
        return {"levels": dict(sorted(self._levels.items())), "history": [list(h) for h in self._history]}
