"""Apply the shop's pricing rules to an order.

    python3 -m pricing.rules RULES_JSON ORDER_JSON

RULES_JSON maps an output name to a formula; formulas are evaluated in file
order and each result becomes a variable for the following formulas.
"""
import json
import sys

from pricing.errors import FormulaError
from pricing.formula import evaluate


def apply_rules(rules, order):
    values = dict(order)
    for name, formula in rules.items():
        values[name] = evaluate(formula, values)
    return values


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        rules = json.load(fh)
    with open(argv[2], encoding="utf-8") as fh:
        order = json.load(fh)
    try:
        result = apply_rules(rules, order)
    except FormulaError as exc:
        print("pricing: %s" % exc, file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
