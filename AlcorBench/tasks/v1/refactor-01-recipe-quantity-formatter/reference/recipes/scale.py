"""Scale a recipe to a different number of servings."""
from fractions import Fraction

from recipes.parse import parse_line
from recipes.units import format_quantity


def scale_recipe(lines, from_servings, to_servings):
    """Scale ingredient lines; returns the new lines as strings."""
    if from_servings <= 0 or to_servings <= 0:
        raise ValueError("servings must be positive")
    factor = Fraction(to_servings, from_servings)
    out = []
    for line in lines:
        qty, unit, name = parse_line(line)
        parts = [format_quantity(qty * factor), unit, name]
        out.append(" ".join(p for p in parts if p))
    return out
