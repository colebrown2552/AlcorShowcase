"""Scale a recipe to a different number of servings."""
from fractions import Fraction

from recipes.parse import parse_line

_GLYPHS = {Fraction(1, 4): "¼", Fraction(1, 3): "⅓", Fraction(1, 2): "½",
           Fraction(2, 3): "⅔", Fraction(3, 4): "¾", Fraction(1, 8): "⅛"}


def _pretty_amount(value):
    """Kitchen-friendly amount: whole part plus a fraction glyph if close."""
    value = Fraction(value).limit_denominator(24)
    whole, rest = divmod(value, 1)
    if rest == 0:
        return str(whole)
    nearest = min(_GLYPHS, key=lambda g: abs(g - rest))
    if abs(nearest - rest) <= Fraction(1, 24):
        return f"{whole} {_GLYPHS[nearest]}" if whole else _GLYPHS[nearest]
    return f"{float(value):.2f}".rstrip("0").rstrip(".")


def scale_recipe(lines, from_servings, to_servings):
    """Scale ingredient lines; returns the new lines as strings."""
    if from_servings <= 0 or to_servings <= 0:
        raise ValueError("servings must be positive")
    factor = Fraction(to_servings, from_servings)
    out = []
    for line in lines:
        qty, unit, name = parse_line(line)
        parts = [_pretty_amount(qty * factor), unit, name]
        out.append(" ".join(p for p in parts if p))
    return out
