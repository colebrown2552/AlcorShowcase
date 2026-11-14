"""Combine several scaled recipes into one shopping list."""
from fractions import Fraction

from recipes.parse import parse_line
from recipes.units import canonical_unit

GLYPHS = {Fraction(1, 4): "¼", Fraction(1, 3): "⅓", Fraction(1, 2): "½",
          Fraction(2, 3): "⅔", Fraction(3, 4): "¾", Fraction(1, 8): "⅛"}

def _fmt_qty(q):
    q = Fraction(q).limit_denominator(24)
    whole, frac = divmod(q, 1)
    if frac == 0:
        return str(whole)
    best = min(GLYPHS, key=lambda g: abs(g - frac))
    if abs(best - frac) <= Fraction(1, 24):
        if whole:
            return f"{whole} {GLYPHS[best]}"
        return GLYPHS[best]
    return f"{float(q):.2f}".rstrip("0").rstrip(".")


def shopping_list(recipes):
    """``recipes`` is a list of (lines, factor). Returns sorted list lines."""
    totals = {}
    for lines, factor in recipes:
        for line in lines:
            qty, unit, name = parse_line(line)
            unit = canonical_unit(unit)
            key = (name.lower(), unit)
            totals[key] = totals.get(key, Fraction(0)) + qty * Fraction(factor)
    out = []
    for (name, unit), qty in sorted(totals.items()):
        out.append(f"{name}: {_fmt_qty(qty)}{' ' + unit if unit else ''}")
    return out
