Shop staff type pricing formulas into the admin page (see `rules.json`, applied by `pricing/rules.py`), and `evaluate` in `pricing/formula.py` runs them with Python's `eval`. That lets anyone with admin access run arbitrary code on the server, and it accepts things that aren't formulas at all. Please replace it with a small evaluator of our own.

`evaluate(expr, variables)` takes the formula string and a dict of variable name -> number (int or float) and returns the result as a `float`. Keep the signature; `pricing/rules.py` must keep working.

The formula language:
- Numbers: digits with an optional decimal part: `3`, `4.95`, `0.5`.
- Variable names: letters, digits and `_`, not starting with a digit (`unit_price`, `qty2`).
- Binary `+`, `-`, `*`, `/` with the usual precedence (`*` and `/` before `+` and `-`), all left-associative: `8 / 2 / 2` is 2 and `7 - 2 - 1` is 4.
- Unary minus and plus, also after another operator: `-x`, `2 * -3`, `5 - -1`.
- Parentheses, nested to any depth.
- Whitespace (spaces, tabs) is allowed anywhere between tokens.

Errors all raise `FormulaError` from `pricing/errors.py` (don't change that file):
- dividing by zero: message exactly `division by zero`;
- a name that is not in `variables`: message exactly `unknown variable 'NAME'`;
- any other invalid formula (empty or blank formula, unbalanced parentheses, two operands or two binary operators in a row, any character or operator not listed above such as `**`, `%`, `.`, `[`, quotes or commas): any message.

Don't use `eval`, `exec`, `compile` or the `ast` module anywhere in the package; parse the formula yourself.

Done means every formula in this language evaluates correctly, everything else raises `FormulaError`, and `python3 -m pricing.rules rules.json ORDER_JSON` still prices an order, e.g. with `{"unit_price": 12.5, "qty": 3, "member_rate": 0.1}`.
