"""Evaluation of the pricing formulas that shop staff type into the admin page.

Grammar (whitespace allowed between tokens):

    expr   := term (('+' | '-') term)*
    term   := factor (('*' | '/') factor)*
    factor := ('+' | '-') factor | NUMBER | NAME | '(' expr ')'
"""
import re

from pricing.errors import FormulaError

_TOKEN = re.compile(r"\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()]))")


def _tokenize(expr):
    tokens, pos = [], 0
    expr = expr.rstrip()
    while pos < len(expr):
        match = _TOKEN.match(expr, pos)
        if not match:
            raise FormulaError("unexpected character %r at %d" % (expr[pos:].lstrip()[:1], pos))
        number, name, op = match.groups()
        if number is not None:
            tokens.append(("num", float(number)))
        elif name is not None:
            tokens.append(("name", name))
        else:
            tokens.append(("op", op))
        pos = match.end()
    return tokens


class _Parser:
    def __init__(self, tokens, variables):
        self.tokens = tokens
        self.pos = 0
        self.variables = variables

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else (None, None)

    def take_op(self, *ops):
        kind, value = self.peek()
        if kind == "op" and value in ops:
            self.pos += 1
            return value
        return None

    def expr(self):
        value = self.term()
        while True:
            op = self.take_op("+", "-")
            if op is None:
                return value
            right = self.term()
            value = value + right if op == "+" else value - right

    def term(self):
        value = self.factor()
        while True:
            op = self.take_op("*", "/")
            if op is None:
                return value
            right = self.factor()
            if op == "*":
                value = value * right
            elif right == 0:
                raise FormulaError("division by zero")
            else:
                value = value / right

    def factor(self):
        op = self.take_op("+", "-")
        if op is not None:
            value = self.factor()
            return -value if op == "-" else value
        kind, value = self.peek()
        if kind == "num":
            self.pos += 1
            return value
        if kind == "name":
            self.pos += 1
            if value not in self.variables:
                raise FormulaError("unknown variable '%s'" % value)
            return float(self.variables[value])
        if self.take_op("("):
            inner = self.expr()
            if not self.take_op(")"):
                raise FormulaError("missing ')'")
            return inner
        raise FormulaError("unexpected end of formula" if kind is None else "unexpected %r" % (value,))


def evaluate(expr, variables):
    """Evaluate `expr` with the given variables and return a float."""
    parser = _Parser(_tokenize(expr), variables)
    value = parser.expr()
    if parser.pos != len(parser.tokens):
        raise FormulaError("unexpected %r" % (parser.peek()[1],))
    return float(value)
