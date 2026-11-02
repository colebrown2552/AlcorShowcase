"""Lexer and recursive-descent parser for canonical AlcorLang (v1 statements, v2 blocks).

The parser produces the canonical AST of spec section 10.1, which the conformance corpus
compares exactly.  Newlines are significant (a statement ends at a newline or ``;``).
Expressions are prefix (Polish) notation with a closed operator set and fixed arities, so there
is no precedence table and ``BRANCH GT $x 3 big ELSE small`` needs no delimiters: the expression
parser consumes exactly ``GT $x 3`` and the next token is the label.
"""

from __future__ import annotations

import re
from typing import Any

from .errors import AlcorLangError
from .vocabulary import canon_element

# A cell name without its `$` sigil.
CELL_RE = re.compile(r"\A[a-z][a-z0-9_]{0,31}\Z")
# A label name: lowercase, unique within one PROGRAM block.
_NAME_RE = re.compile(r"\A[a-z][a-z0-9_]{0,31}\Z")
# A PROGRAM name, which CALL targets by exact spelling.
_PROGNAME_RE = re.compile(r"\A[A-Za-z][A-Za-z0-9_]{0,31}\Z")
# An integer literal: optional minus sign, then decimal digits.
INT_RE = re.compile(r"\A-?[0-9]+\Z")
# A `$cell` placeholder inside the text of an embedded v1 statement.
INTERP_RE = re.compile(r"\$([a-z][a-z0-9_]{0,31})")

# Spec section 1.4: the closed operator set with fixed arities.  It is distinct from the
# vocabulary table, which names v1 verbs and objects.
#
# CHAR and FIND are the smallest addition that lets a program look inside a string.  Without
# them a language with LEN and CAT cannot write a lexer, and so cannot host itself.  Both are
# binary, so no new instruction kind is needed in any backend, and the rest of what a
# self-hosted interpreter wants (slice, split, trim) is then an ordinary PROGRAM built from
# them (see selfhost/alcorlang.alcor).
OPS: dict[str, int] = {
    "ADD": 2,
    "SUB": 2,
    "MUL": 2,
    "DIV": 2,
    "MOD": 2,
    "NEG": 1,
    "CAT": 2,
    "LEN": 1,
    "STR": 1,
    "INT": 1,
    "CHAR": 2,
    "FIND": 2,
    "EQ": 2,
    "NE": 2,
    "LT": 2,
    "LE": 2,
    "GT": 2,
    "GE": 2,
    "AND": 2,
    "OR": 2,
    "NOT": 1,
}

# Spec section 1.3 reserved words.  SET, RUN, EXEC, START, IF, THEN and HOOK are deliberately
# not claimed: they are live v1 aliases, and claiming them would change what v1 programs mean.
RESERVED = frozenset(
    [
        "PROGRAM",
        "END",
        "LABEL",
        "JUMP",
        "BRANCH",
        "LOOP",
        "WHILE",
        "CALL",
        "LET",
        "INTO",
        "ELSE",
        "RETURN",
        "EMIT",
        "READ",
    ]
)
_STMT_HEADS = frozenset(
    ["LET", "EMIT", "READ", "LABEL", "JUMP", "BRANCH", "LOOP", "CALL", "RETURN"]
)


# ---------------------------------------------------------------------------
# Lexer.  Newlines are significant (spec section 1.3: statements separate by NL or ';').
# ---------------------------------------------------------------------------


class Tok:
    """One lexical token: its kind, its text and the 1-based line it came from.

    Kinds are ``word``, ``str``, ``cell``, ``eq``, ``nl``, ``semi`` and ``eof``.
    """

    __slots__ = ("kind", "text", "line")

    def __init__(self, kind: str, text: str, line: int) -> None:
        self.kind = kind
        self.text = text
        self.line = line

    def __repr__(self) -> str:
        return f"Tok({self.kind},{self.text!r})"


_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t", "r": "\r"}

# A word ends at whitespace or at any of these.  '=' must break so that `profile=complete` and
# `$x=$n` lex as three tokens, while `t.txt` stays one.
_WORD_BREAK = set(' \t\r\n;="')


def lex(src: str) -> list[Tok]:
    """Split source text into tokens.

    Args:
        src: The program text, after INCLUDE splicing.

    Returns:
        The tokens, always ending with a single ``eof`` token.

    Raises:
        AlcorLangError: On an unterminated string, an unknown escape, a bad cell name or a
            stray character.
    """
    toks: list[Tok] = []
    i, line, n = 0, 1, len(src)
    while i < n:
        ch = src[i]
        if ch in " \t\r":
            i += 1
            continue
        if ch == "\n":
            toks.append(Tok("nl", "\n", line))
            line += 1
            i += 1
            continue
        if ch == ";":
            toks.append(Tok("semi", ";", line))
            i += 1
            continue
        if ch == "=":
            toks.append(Tok("eq", "=", line))
            i += 1
            continue
        if ch == '"':
            i += 1
            buf = []
            while True:
                if i >= n:
                    raise AlcorLangError(f"line {line}: unterminated string literal")
                c = src[i]
                if c == '"':
                    i += 1
                    break
                if c == "\n":
                    raise AlcorLangError(f"line {line}: newline inside string literal")
                if c == "\\":
                    if i + 1 >= n or src[i + 1] not in _ESCAPES:
                        raise AlcorLangError(
                            f"line {line}: unknown escape {src[i : i + 2]!r} in string literal"
                        )
                    buf.append(_ESCAPES[src[i + 1]])
                    i += 2
                    continue
                buf.append(c)
                i += 1
            toks.append(Tok("str", "".join(buf), line))
            continue
        if ch == "$":
            j = i + 1
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            name = src[i + 1 : j]
            if not CELL_RE.match(name):
                raise AlcorLangError(
                    f"line {line}: bad cell name {'$' + name!r} (want $[a-z][a-z0-9_]{{0,31}})"
                )
            toks.append(Tok("cell", name, line))
            i = j
            continue
        j = i
        while j < n and src[j] not in _WORD_BREAK:
            j += 1
        if j == i:
            raise AlcorLangError(f"line {line}: unexpected character {ch!r}")
        toks.append(Tok("word", src[i:j], line))
        i = j
    toks.append(Tok("eof", "", line))
    return toks


# ---------------------------------------------------------------------------
# Parser -> the canonical AST of §10.1 (exact-compared by the referee).
# ---------------------------------------------------------------------------


class Parser:
    """Recursive-descent parser over a token list; ``parse_module`` is the entry point.

    One token of lookahead is enough everywhere because expressions are prefix with fixed arities.
    Bad input raises ``AlcorLangError``, naming the offending line where there is one.
    """

    def __init__(self, toks: list[Tok]) -> None:
        self.t = toks
        self.i = 0

    def peek(self, k: int = 0) -> Tok:
        """Return the token ``k`` ahead without consuming it (clamped to ``eof``)."""
        j = min(self.i + k, len(self.t) - 1)
        return self.t[j]

    def next(self) -> Tok:
        """Consume and return the current token; ``eof`` is never consumed past."""
        tok = self.t[self.i]
        if tok.kind != "eof":
            self.i += 1
        return tok

    def at_word(self, word: str) -> bool:
        """Return whether the current token is exactly the word ``word``."""
        tok = self.peek()
        return tok.kind == "word" and tok.text == word

    def at_end(self) -> bool:
        """Return whether the current token ends a statement."""
        return self.peek().kind in ("nl", "semi", "eof")

    def skip_seps(self) -> None:
        """Skip any run of newlines and semicolons."""
        while self.peek().kind in ("nl", "semi"):
            self.i += 1

    def end_stmt(self, what: str) -> None:
        """Consume the separator that must follow a statement, or fail."""
        if self.peek().kind == "eof":
            return
        if self.peek().kind in ("nl", "semi"):
            self.i += 1
            return
        tok = self.peek()
        raise AlcorLangError(f"line {tok.line}: unexpected {tok.text!r} after {what} statement")

    def want_word(self, what: str) -> Tok:
        """Consume a word token, or fail naming what was expected."""
        tok = self.next()
        if tok.kind != "word":
            raise AlcorLangError(f"line {tok.line}: expected {what}, got {tok.text!r}")
        return tok

    def want_cell(self, what: str) -> str:
        """Consume a ``$cell`` token and return its name without the sigil."""
        tok = self.next()
        if tok.kind != "cell":
            raise AlcorLangError(
                f"line {tok.line}: {what} must be a $cell, got {tok.text!r} "
                "(bare identifiers are not cells)"
            )
        return tok.text

    def want_label(self, what: str) -> str:
        """Consume a label name (lowercase, not a reserved word)."""
        tok = self.want_word(what)
        if not _NAME_RE.match(tok.text) or tok.text in RESERVED:
            raise AlcorLangError(
                f"line {tok.line}: bad {what} {tok.text!r} (want [a-z][a-z0-9_]{{0,31}})"
            )
        return tok.text

    # -- module ------------------------------------------------------------
    def parse_module(self) -> dict[str, Any]:
        """Parse a whole module into ``{"type": "module", "body": [...]}``.

        A source whose first token is not ``PROGRAM`` is a v1 program: exactly one statement
        (spec section 1.1).  Otherwise it is a sequence of PROGRAM blocks and v1 statements.
        """
        self.skip_seps()
        if not self.at_word("PROGRAM"):
            # §1.1 dispatch: first token is not PROGRAM => a v1 program, which is
            # exactly one statement. Anything after it is a v1 violation.
            stmt = self.parse_v1()
            self.end_stmt("v1")
            self.skip_seps()
            if self.peek().kind != "eof":
                raise AlcorLangError(
                    f"line {self.peek().line}: a v1 program is exactly one statement (§1.1)"
                )
            return {"type": "module", "body": [stmt]}
        body = []
        while True:
            self.skip_seps()
            if self.peek().kind == "eof":
                break
            if self.at_word("PROGRAM"):
                body.append(self.parse_program())
            else:
                body.append(self.parse_v1())
            self.end_stmt("module-level")
        return {"type": "module", "body": body}

    def parse_program(self) -> dict[str, Any]:
        """Parse one ``PROGRAM [Name] [WITH k=v ...]`` block up to ``END PROGRAM``."""
        self.want_word("PROGRAM")
        name = None
        tok = self.peek()
        if tok.kind == "word" and tok.text != "WITH":
            self.next()
            if not _PROGNAME_RE.match(tok.text) or tok.text in RESERVED:
                raise AlcorLangError(f"line {tok.line}: bad program name {tok.text!r}")
            name = tok.text
        props = {}
        if self.at_word("WITH"):
            self.next()
            props = self.parse_props(stop=())
        if self.peek().kind not in ("nl", "semi"):
            tok = self.peek()
            raise AlcorLangError(
                f"line {tok.line}: expected end of PROGRAM header, got {tok.text!r}"
            )
        self.next()
        body = self.parse_stmt_list("PROGRAM")
        return {"type": "program", "name": name, "props": props, "body": body}

    def parse_stmt_list(self, closer: str) -> list[dict[str, Any]]:
        """Parse statements until ``END <closer>`` and return them."""
        stmts = []
        while True:
            self.skip_seps()
            tok = self.peek()
            if tok.kind == "eof":
                raise AlcorLangError(f"unterminated block: expected END {closer}")
            if tok.kind == "word" and tok.text == "END":
                self.next()
                got = self.want_word("END target")
                if got.text != closer:
                    raise AlcorLangError(f"line {got.line}: END {got.text} does not close {closer}")
                return stmts
            stmts.append(self.parse_stmt())
            self.end_stmt("block")

    # -- statements --------------------------------------------------------
    def parse_stmt(self) -> dict[str, Any]:
        """Parse one statement: a v2 keyword form or an embedded v1 effect."""
        tok = self.peek()
        if tok.kind != "word":
            raise AlcorLangError(
                f"line {tok.line}: statement must start with a keyword or a "
                f"v1 verb, got {tok.text!r}"
            )
        head = tok.text
        if head in _STMT_HEADS:
            return getattr(self, "_st_" + head.lower())()
        if head in RESERVED:
            raise AlcorLangError(f"line {tok.line}: reserved word {head!r} is not a statement head")
        return self.parse_v1()

    def _st_let(self) -> dict[str, Any]:
        self.next()
        cell = self.want_cell("LET target")
        return {"type": "let", "cell": cell, "expr": self.parse_expr()}

    def _st_emit(self) -> dict[str, Any]:
        self.next()
        return {"type": "emit", "expr": self.parse_expr()}

    def _st_read(self) -> dict[str, Any]:
        self.next()
        return {"type": "read", "cell": self.want_cell("READ target")}

    def _st_label(self) -> dict[str, Any]:
        self.next()
        return {"type": "label", "name": self.want_label("label name")}

    def _st_jump(self) -> dict[str, Any]:
        self.next()
        return {"type": "jump", "name": self.want_label("jump target")}

    def _st_branch(self) -> dict[str, Any]:
        self.next()
        cond = self.parse_expr()
        then = self.want_label("BRANCH then-label")
        other = None
        if self.at_word("ELSE"):
            self.next()
            other = self.want_label("BRANCH else-label")
        return {"type": "branch", "cond": cond, "then": then, "else": other}

    def _st_loop(self) -> dict[str, Any]:
        self.next()
        tok = self.want_word("WHILE")
        if tok.text != "WHILE":
            raise AlcorLangError(f"line {tok.line}: LOOP must be followed by WHILE")
        cond = self.parse_expr()
        if self.peek().kind not in ("nl", "semi"):
            raise AlcorLangError(
                f"line {self.peek().line}: expected end of line after LOOP WHILE <expr>"
            )
        self.next()
        return {"type": "loop_while", "cond": cond, "body": self.parse_stmt_list("LOOP")}

    def _st_call(self) -> dict[str, Any]:
        self.next()
        tok = self.want_word("CALL target")
        if not _PROGNAME_RE.match(tok.text) or tok.text in RESERVED:
            raise AlcorLangError(f"line {tok.line}: bad CALL target {tok.text!r}")
        args = {}
        if self.at_word("WITH"):
            self.next()
            while self.peek().kind == "cell":
                cell = self.next().text
                if self.peek().kind != "eq":
                    raise AlcorLangError(
                        f"line {self.peek().line}: CALL arg ${cell} needs '=' then an expr"
                    )
                self.next()
                if cell in args:
                    raise AlcorLangError(f"duplicate CALL arg ${cell}")
                args[cell] = self.parse_expr()
            if not args:
                raise AlcorLangError(
                    f"line {self.peek().line}: CALL ... WITH needs at least one $cell=expr"
                )
        into = None
        if self.at_word("INTO"):
            self.next()
            into = self.want_cell("INTO target")
        return {"type": "call", "program": tok.text, "args": args, "into": into}

    def _st_return(self) -> dict[str, Any]:
        self.next()
        if self.at_end():
            return {"type": "return", "expr": None}
        return {"type": "return", "expr": self.parse_expr()}

    # -- expressions (§1.4, prefix) ---------------------------------------
    def parse_expr(self) -> dict[str, Any]:
        """Parse one prefix expression (spec section 1.4) into its AST node."""
        tok = self.next()
        if tok.kind == "str":
            return {"str": tok.text}
        if tok.kind == "cell":
            return {"cell": tok.text}
        if tok.kind == "word":
            if INT_RE.match(tok.text):
                return {"int": int(tok.text)}
            if tok.text in OPS:
                return {"op": tok.text, "args": [self.parse_expr() for _ in range(OPS[tok.text])]}
            raise AlcorLangError(
                f"line {tok.line}: {tok.text!r} is not an operator, an integer, a string or a $cell"
            )
        raise AlcorLangError(f"line {tok.line}: expression ended early (got {tok.kind})")

    # -- v1 (§1.2) ---------------------------------------------------------
    def parse_props(self, stop: tuple[str, ...]) -> dict[str, str]:
        """Parse ``k=v`` pairs, stopping before any word in ``stop``."""
        props = {}
        while True:
            tok = self.peek()
            if tok.kind != "word" or tok.text in stop:
                break
            if self.peek(1).kind != "eq":
                break
            key = self.next().text
            self.next()
            val = self.next()
            if val.kind not in ("word", "str"):
                raise AlcorLangError(f"line {val.line}: property {key}= needs a value")
            if key in props:
                raise AlcorLangError(f"line {val.line}: duplicate property {key!r}")
            props[key] = val.text
        if not props:
            raise AlcorLangError(f"line {self.peek().line}: WITH needs at least one prop=value")
        return props

    def parse_v1(self) -> dict[str, Any]:
        """Parse one v1 statement: ``VERB OBJECT [value] [WITH ...] [TO|FROM ...]``."""
        vtok = self.want_word("v1 verb")
        verb = canon_element(vtok.text, "verb")
        otok = self.want_word("v1 object")
        obj = canon_element(otok.text, "object")
        value = None
        if self.peek().kind == "str":
            value = self.next().text
        props = {}
        if self.at_word("WITH"):
            self.next()
            props = self.parse_props(stop=("TO", "FROM"))
        tail = None
        if self.at_word("TO") or self.at_word("FROM"):
            direction = self.next().text
            ttok = self.want_word("v1 tail object")
            tobj = canon_element(ttok.text, "object")
            parts = []
            while not self.at_end():
                tok = self.next()
                if tok.kind == "cell":
                    # §11.4: cell interpolation in TO/FROM names is forbidden in
                    # this spec version — it is a path-injection risk.
                    raise AlcorLangError(
                        f"line {tok.line}: $cell interpolation is forbidden in a TO/FROM "
                        f"name/path (§11.4)"
                    )
                parts.append(tok.text)
            tail = {"dir": direction, "object": tobj, "name": " ".join(parts) if parts else None}
        return {
            "type": "v1",
            "verb": verb,
            "object": obj,
            "value": value,
            "props": props,
            "tail": tail,
        }
