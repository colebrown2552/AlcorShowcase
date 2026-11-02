"""Deterministic infix-expression parser that lowers to AlcorLang v2 prefix form.

The scanner and a precedence-climbing parser build a small tree, which is then printed as the
prefix notation the v2 core already parses.  Nothing is ever evaluated here, and there is no
``eval`` anywhere: unknown identifiers and wrong arities are errors.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .common import AlcorLangV3Error, ETok, Expr

# Binary operators as (binding power, v2 operator).  Higher binds tighter; all are left
# associative.  The precedence table is spec v3 section 3.2.
_BINARY = {
    "||": (10, "OR"),
    "&&": (20, "AND"),
    "==": (30, "EQ"),
    "!=": (30, "NE"),
    "<": (40, "LT"),
    "<=": (40, "LE"),
    ">": (40, "GT"),
    ">=": (40, "GE"),
    "++": (45, "CAT"),
    "+": (50, "ADD"),
    "-": (50, "SUB"),
    "*": (60, "MUL"),
    "/": (60, "DIV"),
    "%": (60, "MOD"),
}
_UNARY = {"!": "NOT", "-": "NEG"}
_COMPARISONS = frozenset({"EQ", "NE", "LT", "LE", "GT", "GE"})
_FUNCTIONS = {
    "len": (1, "LEN"),
    "str": (1, "STR"),
    "int": (1, "INT"),
    "cat": (2, "CAT"),
    "add": (2, "ADD"),
    "sub": (2, "SUB"),
    "mul": (2, "MUL"),
    "div": (2, "DIV"),
    "mod": (2, "MOD"),
}


def _scan_expr(text: str) -> list[ETok]:
    toks: list[ETok] = []
    i = 0
    decoder = json.JSONDecoder()
    while i < len(text):
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        if ch == '"':
            try:
                value, used = decoder.raw_decode(text[i:])
            except json.JSONDecodeError as exc:
                raise AlcorLangV3Error(f"expression column {i + 1}: {exc.msg}") from None
            if not isinstance(value, str):
                raise AlcorLangV3Error("expression string decoder returned non-string")
            toks.append(ETok("str", value, i))
            i += used
            continue
        if ch == "$":
            m = re.match(r"\$[a-z][a-z0-9_]{0,31}", text[i:])
            if not m:
                raise AlcorLangV3Error(f"expression column {i + 1}: invalid cell")
            toks.append(ETok("cell", m.group(0), i))
            i += len(m.group(0))
            continue
        number = re.match(r"(?:0|[1-9][0-9]*)", text[i:])
        if number:
            toks.append(ETok("int", int(number.group(0)), i))
            i += len(number.group(0))
            continue
        ident = re.match(r"[A-Za-z_][A-Za-z0-9_]*", text[i:])
        if ident:
            toks.append(ETok("ident", ident.group(0).lower(), i))
            i += len(ident.group(0))
            continue
        matched = False
        for op in ("||", "&&", "==", "!=", "<=", ">=", "++"):
            if text.startswith(op, i):
                toks.append(ETok("op", op, i))
                i += len(op)
                matched = True
                break
        if matched:
            continue
        if ch in "+-*/%<>!(),":
            kind = ch if ch in "()," else "op"
            toks.append(ETok(kind, ch, i))
            i += 1
            continue
        raise AlcorLangV3Error(f"expression column {i + 1}: unexpected character {ch!r}")
    toks.append(ETok("eof", None, len(text)))
    return toks


class _ExprParser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.toks = _scan_expr(text)
        self.i = 0

    def tok(self) -> ETok:
        return self.toks[self.i]

    def take(self, kind: str, value: Any | None = None) -> ETok:
        tok = self.tok()
        if tok.kind != kind or (value is not None and tok.value != value):
            wanted = f"{kind} {value!r}" if value is not None else kind
            raise AlcorLangV3Error(
                f"expression column {tok.pos + 1}: expected {wanted}, got {tok.kind} {tok.value!r}"
            )
        self.i += 1
        return tok

    def parse(self) -> Expr:
        expr = self.parse_bp(0)
        if self.tok().kind != "eof":
            tok = self.tok()
            raise AlcorLangV3Error(
                f"expression column {tok.pos + 1}: unexpected token {tok.value!r}"
            )
        return expr

    def parse_bp(self, min_bp: int) -> Expr:
        tok = self.tok()
        if tok.kind == "op" and tok.value in _UNARY:
            self.i += 1
            lhs = Expr("op", _UNARY[str(tok.value)], (self.parse_bp(70),))
        elif tok.kind == "int":
            self.i += 1
            lhs = Expr("int", tok.value)
        elif tok.kind == "str":
            self.i += 1
            lhs = Expr("str", tok.value)
        elif tok.kind == "cell":
            self.i += 1
            lhs = Expr("cell", str(tok.value))
        elif tok.kind == "ident":
            self.i += 1
            name = str(tok.value)
            if name in {"true", "false"}:
                lhs = Expr("bool", name == "true")
            elif self.tok().kind == "(":
                lhs = self.parse_call(name, tok.pos)
            else:
                raise AlcorLangV3Error(
                    f"expression column {tok.pos + 1}: unknown identifier {name!r}"
                )
        elif tok.kind == "(":
            self.i += 1
            lhs = self.parse_bp(0)
            self.take(")")
        else:
            raise AlcorLangV3Error(
                f"expression column {tok.pos + 1}: expected value, got {tok.value!r}"
            )

        while True:
            tok = self.tok()
            if tok.kind != "op" or tok.value not in _BINARY:
                break
            bp, opname = _BINARY[str(tok.value)]
            if bp < min_bp:
                break
            self.i += 1
            rhs = self.parse_bp(bp + 1)
            if opname in _COMPARISONS and lhs.kind == "op" and lhs.value in _COMPARISONS:
                raise AlcorLangV3Error(
                    f"expression column {tok.pos + 1}: chained comparisons are not "
                    "part of AlcorLang v3; combine comparisons with && explicitly"
                )
            lhs = Expr("op", opname, (lhs, rhs))
        return lhs

    def parse_call(self, name: str, pos: int) -> Expr:
        if name not in _FUNCTIONS:
            raise AlcorLangV3Error(f"expression column {pos + 1}: unknown function {name!r}")
        self.take("(")
        args: list[Expr] = []
        if self.tok().kind != ")":
            while True:
                args.append(self.parse_bp(0))
                if self.tok().kind == ",":
                    self.i += 1
                    continue
                break
        self.take(")")
        arity, opname = _FUNCTIONS[name]
        if len(args) != arity:
            raise AlcorLangV3Error(
                f"expression function {name} expects {arity} args, got {len(args)}"
            )
        return Expr("op", opname, tuple(args))


def parse_expression(text: str) -> Expr:
    """Parse an infix expression into a tree.

    Raises:
        AlcorLangV3Error: On an empty or malformed expression, an unknown identifier or function,
            a wrong function arity, or a chained comparison such as ``a < b < c``.
    """
    if not text.strip():
        raise AlcorLangV3Error("empty expression")
    return _ExprParser(text).parse()


def _quote_v2_string(value: str) -> str:
    """Encode only strings accepted by the canonical v2 lexer."""
    for ch in value:
        code = ord(ch)
        if 0xD800 <= code <= 0xDFFF:
            raise AlcorLangV3Error("expression string contains an invalid surrogate code point")
        if code < 32 and ch not in {"\n", "\t", "\r"}:
            raise AlcorLangV3Error(
                f"expression string contains unsupported control character U+{code:04X}"
            )
    return json.dumps(value, ensure_ascii=False)


def expr_to_v2(expr: Expr) -> str:
    """Print an expression tree as a v2 prefix expression.

    Booleans lower to pure comparisons (``EQ 1 1`` and ``EQ 1 0``) because v2 has no boolean
    literal.
    """
    if expr.kind == "int":
        return str(expr.value)
    if expr.kind == "str":
        return _quote_v2_string(str(expr.value))
    if expr.kind == "cell":
        return str(expr.value)
    if expr.kind == "bool":
        return "EQ 1 1" if expr.value else "EQ 1 0"
    if expr.kind == "op":
        return " ".join([str(expr.value), *(expr_to_v2(arg) for arg in expr.args)])
    raise AssertionError(f"unknown expression kind {expr.kind}")


def compile_expression(text: str) -> str:
    """Compile an infix expression string straight to v2 prefix text.

    For example ``2 + 3 * 4`` becomes ``ADD 2 MUL 3 4``.
    """
    return expr_to_v2(parse_expression(text))


def literal_int(expr: Expr) -> int | None:
    """Return the value of an integer literal node (including a negated one), else ``None``."""
    if expr.kind == "int":
        return int(expr.value)
    if (
        expr.kind == "op"
        and expr.value == "NEG"
        and len(expr.args) == 1
        and expr.args[0].kind == "int"
    ):
        return -int(expr.args[0].value)
    return None
