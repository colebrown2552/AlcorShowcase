"""Kitchen units shared by the recipe tools."""

_SINGULAR = {"cups": "cup", "cloves": "clove"}


def canonical_unit(unit):
    """Singular, lower-case form of a unit name ('Cups' -> 'cup')."""
    unit = unit.lower()
    return _SINGULAR.get(unit, unit)
