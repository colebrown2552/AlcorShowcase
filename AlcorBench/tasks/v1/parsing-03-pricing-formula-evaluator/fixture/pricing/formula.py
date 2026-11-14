"""Evaluation of the pricing formulas that shop staff type into the admin page."""
from pricing.errors import FormulaError


def evaluate(expr, variables):
    """Evaluate `expr` with the given variables and return a float."""
    try:
        return float(eval(expr, {}, dict(variables)))
    except ZeroDivisionError:
        raise FormulaError("division by zero")
