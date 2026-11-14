"""Kitchen units shared by the recipe tools."""
from fractions import Fraction

_SINGULAR = {"cups": "cup", "cloves": "clove"}

GLYPHS = {Fraction(1, 4): "¼", Fraction(1, 3): "⅓", Fraction(1, 2): "½",
          Fraction(2, 3): "⅔", Fraction(3, 4): "¾", Fraction(1, 8): "⅛"}


def canonical_unit(unit):
    """Singular, lower-case form of a unit name ('Cups' -> 'cup')."""
    unit = unit.lower()
    return _SINGULAR.get(unit, unit)


def format_quantity(value):
    """Kitchen-friendly amount: whole part plus a fraction glyph if close,
    otherwise a decimal with at most two places."""
    value = Fraction(value).limit_denominator(24)
    whole, rest = divmod(value, 1)
    if rest == 0:
        return str(whole)
    nearest = min(GLYPHS, key=lambda g: abs(g - rest))
    if abs(nearest - rest) <= Fraction(1, 24):
        return f"{whole} {GLYPHS[nearest]}" if whole else GLYPHS[nearest]
    return f"{float(value):.2f}".rstrip("0").rstrip(".")
