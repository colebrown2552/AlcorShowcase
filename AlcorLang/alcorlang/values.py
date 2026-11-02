"""Values and the total operator semantics of spec section 6.2.

Every operator is defined for every input.  An ill-typed or out-of-range combination has a
named trap instead of undefined behaviour.  The Python and C backends must agree with these
functions byte for byte, which is why floor division and divisor-signed modulo are spelled out.
"""

from __future__ import annotations

from typing import TypeAlias

from .errors import AlcorLangError, Trap
from .syntax import INT_RE

# The three value types of spec section 6.2.  Integers are unbounded in the reference.
Value: TypeAlias = int | str | bool


def render(val: Value) -> str:
    """Render a value the way EMIT writes it (spec section 6.3).

    ``bool`` is tested first because it is a subclass of ``int`` in Python.
    """
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, int):
        return str(val)
    return val


def truth(val: Value) -> bool:
    """Return a value's truthiness (spec section 4).

    A bool is itself, an int is true when non-zero and a string is true when non-empty.
    """
    if isinstance(val, bool):
        return val
    if isinstance(val, int):
        return val != 0
    return val != ""


def _is_int(val: object) -> bool:
    # `type(...) is int` rather than isinstance: bool is a distinct value type in section 6.2.
    return type(val) is int


def _is_str(val: object) -> bool:
    return type(val) is str


def _same_type(a: object, b: object) -> bool:
    return (
        (_is_int(a) and _is_int(b))
        or (_is_str(a) and _is_str(b))
        or (isinstance(a, bool) and isinstance(b, bool))
    )


def binop(op: str, a: Value, b: Value) -> Value:
    """Apply a binary operator with the total semantics of spec section 6.2.

    Args:
        op: One of the binary operator names in ``OPS``.
        a: Left operand.
        b: Right operand.

    Returns:
        The result value.

    Raises:
        Trap: ``type_mismatch`` for an ill-typed pair, ``div_zero`` or ``mod_zero`` for a zero
            divisor.
        AlcorLangError: If ``op`` is not a binary operator (an internal error).
    """
    if op in ("ADD", "SUB", "MUL", "DIV", "MOD"):
        if not (_is_int(a) and _is_int(b)):
            raise Trap("type_mismatch")
        if op == "ADD":
            return a + b
        if op == "SUB":
            return a - b
        if op == "MUL":
            return a * b
        if b == 0:
            raise Trap("div_zero" if op == "DIV" else "mod_zero")
        return a // b if op == "DIV" else a % b  # floor / divisor-signed
    if op == "CAT":
        if not (_is_str(a) and _is_str(b)):
            raise Trap("type_mismatch")
        return a + b
    if op == "CHAR":
        # s, i -> the one-character string at i, or "" when i is off the end.
        # TOTAL on purpose: a lexer's inner loop tests "am I past the end?" on every
        # step, and a trap there would mean the only way to ask is to have already
        # fallen off. "" is falsy under truth(), so `BRANCH EQ $c ""` is the test.
        if not (_is_str(a) and _is_int(b)) or isinstance(b, bool):
            raise Trap("type_mismatch")
        if b < 0 or b >= len(a):
            return ""
        return a[b]
    if op == "FIND":
        # s, needle -> index of the first occurrence, or -1. Also total.
        if not (_is_str(a) and _is_str(b)):
            raise Trap("type_mismatch")
        return a.find(b)
    if op in ("EQ", "NE"):
        same = _same_type(a, b) and a == b  # cross-type never traps
        return same if op == "EQ" else not same
    if op in ("LT", "LE", "GT", "GE"):
        if not ((_is_int(a) and _is_int(b)) or (_is_str(a) and _is_str(b))):
            raise Trap("type_mismatch")
        if op == "LT":
            return a < b
        if op == "LE":
            return a <= b
        if op == "GT":
            return a > b
        return a >= b
    if op == "AND":
        return truth(a) and truth(b)  # both args already evaluated
    if op == "OR":
        return truth(a) or truth(b)
    raise AlcorLangError(f"unknown binary operator {op!r}")


def unop(op: str, a: Value) -> Value:
    """Apply a unary operator with the total semantics of spec section 6.2.

    Args:
        op: One of the unary operator names in ``OPS``.
        a: The operand.

    Returns:
        The result value.

    Raises:
        Trap: ``type_mismatch`` or ``bad_int`` for an operand the operator is not defined on.
        AlcorLangError: If ``op`` is not a unary operator (an internal error).
    """
    if op == "NEG":
        if not _is_int(a):
            raise Trap("type_mismatch")
        return -a
    if op == "LEN":
        if not _is_str(a):
            raise Trap("type_mismatch")
        return len(a)
    if op == "STR":
        return render(a)
    if op == "INT":
        if isinstance(a, bool):
            return 1 if a else 0
        if _is_int(a):
            return a
        if _is_str(a) and INT_RE.match(a):
            return int(a)
        raise Trap("bad_int")
    if op == "NOT":
        return not truth(a)
    raise AlcorLangError(f"unknown unary operator {op!r}")
