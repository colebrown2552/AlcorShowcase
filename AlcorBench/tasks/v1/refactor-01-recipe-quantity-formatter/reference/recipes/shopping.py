"""Combine several scaled recipes into one shopping list."""
from fractions import Fraction

from recipes.parse import parse_line
from recipes.units import canonical_unit, format_quantity

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
        out.append(f"{name}: {format_quantity(qty)}{' ' + unit if unit else ''}")
    return out
