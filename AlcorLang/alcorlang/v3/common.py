"""Shared constants, data types and source utilities for the AlcorLang v3 frontend.

The limits here are admission limits: v3 rejects a source that exceeds them instead of trying
to lower it, because a lowered program must stay inside the v2 core's safety invariants.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

VERSION = "3.0.0-preview.1"
MAX_SOURCE_BYTES = 1_048_576
MAX_DIRECTIVES = 128
MAX_DIRECTIVE_DEPTH = 8
MAX_DIRECTIVE_ITEMS = 256
MAX_DIRECTIVE_STRING = 65_536
MAX_UNROLL = 1_000
MAX_CONTEXT_INPUT = 1_000_000
MAX_CONTEXT_OUTPUT = 100_000

_LABEL_RE = re.compile(r"\A[a-z][a-z0-9_]{0,31}\Z")
PROGRAM_RE = re.compile(r"\APROGRAM(?:\s|\Z)", re.IGNORECASE)
THREAD_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._/-]{0,127}\Z")

# The closed set of `.alcor.*` directive names.  The first thirteen are the portable control
# vocabulary (goals, models, threads, status, templates, context budgets, memory); `source`,
# `target`, `translate` and `compile` are language-neutral translation primitives.  Unknown
# names fail closed.
DIRECTIVES = frozenset(
    {
        "goal",
        "model",
        "thread",
        "list",
        "select",
        "run",
        "stop",
        "status",
        "history",
        "template",
        "context",
        "memory",
        "capabilities",
        "source",
        "target",
        "translate",
        "compile",
    }
)
# Read-only directives lower to `View Task`; the rest lower to `Update Task`.
QUERY_DIRECTIVES = frozenset({"list", "status", "history", "capabilities"})
ACTION_DIRECTIVES = frozenset({"run", "stop", "translate", "compile"})
# Directives that establish a binding later directives may refer to as `.alcor.<name>`.
BINDING_DIRECTIVES = frozenset(
    {"goal", "model", "thread", "select", "template", "context", "memory", "source", "target"}
)
REQUIRED_VALUE = frozenset({"goal", "model", "thread", "select", "template", "source", "target"})
# Keys that look like credentials.  Source text never carries credentials, so these are
# rejected anywhere in a directive payload.
SECRET_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "password",
        "authorization",
        "cookie",
        "private_key",
        "credential",
    }
)


class AlcorLangV3Error(ValueError):
    """A lexical, grammar or semantic rejection in the v3 frontend."""


@dataclass(frozen=True)
class TokenRef:
    """A reference to another directive's binding, such as ``.alcor.thread``.

    It is data only: it is serialised as ``{"token_ref": "alcor.<name>"}`` and never executed
    or interpolated.
    """

    name: str


@dataclass(frozen=True)
class Directive:
    """One parsed ``.alcor.<name>(...)`` directive with positional and keyword arguments."""

    name: str
    args: tuple[Any, ...] = ()
    kwargs: dict[str, Any] = field(default_factory=dict)

    def payload(self) -> dict[str, Any]:
        """Return the canonical ``alcor.directive.v1`` payload with keyword keys sorted."""
        return {
            "schema": "alcor.directive.v1",
            "name": self.name,
            "args": [jsonable(v) for v in self.args],
            "kwargs": {k: jsonable(v) for k, v in sorted(self.kwargs.items())},
        }


@dataclass
class _DirectiveBudget:
    """Static per-program directive budget shared by all control-flow paths.

    Branch states clone semantic bindings, but they intentionally share this
    counter: both arms exist in source and therefore both count toward the
    program's 128-directive admission limit even though only one runs.
    """

    count: int = 0


@dataclass
class DirectiveState:
    """Per-path directive bindings plus the program-wide directive budget.

    ``bound`` is the set of directive names whose binding is established on every path reaching
    the current statement.  ``budget`` is shared by all clones, because both arms of an ``IF``
    exist in the source and so both count toward the program's directive limit.
    """

    bound: set[str] = field(default_factory=set)
    budget: _DirectiveBudget = field(default_factory=_DirectiveBudget)

    @property
    def count(self) -> int:
        """How many directives the program has used so far, across all paths."""
        return self.budget.count

    @count.setter
    def count(self, value: int) -> None:
        self.budget.count = value

    def clone(self) -> DirectiveState:
        """Return a state with the same bindings that shares this state's budget."""
        return DirectiveState(set(self.bound), self.budget)

    def merge_intersection(self, *others: DirectiveState) -> None:
        """Keep only the bindings that every given state established.

        This is what makes bindings conservative across ``IF``: a binding is available after
        the statement only when both branches establish it.
        """
        if not others:
            return
        common = set(others[0].bound)
        for state in others[1:]:
            common.intersection_update(state.bound)
        self.bound = common


@dataclass(frozen=True)
class Expr:
    """A node of the infix expression tree: ``int``, ``str``, ``cell``, ``bool`` or ``op``."""

    kind: str
    value: Any = None
    args: tuple[Expr, ...] = ()


@dataclass(frozen=True)
class ETok:
    """A token of the infix expression scanner, with its 0-based source position."""

    kind: str
    value: Any
    pos: int


@dataclass(frozen=True)
class DTok:
    """A token of the directive scanner, with its 0-based source position."""

    kind: str
    value: Any
    pos: int


class Labels:
    """Generates fresh, program-local label and cell names that cannot collide with source.

    Args:
        reserved: Names already used by the source; none of them is ever generated.
    """

    def __init__(self, reserved: Iterable[str] = ()) -> None:
        self.reserved = set(reserved)
        self.seq = 0

    def new(self, stem: str) -> str:
        """Return a unique, valid v2 label name starting with a sanitised ``stem``."""
        stem = re.sub(r"[^a-z0-9_]", "_", stem.lower())[:20] or "v3"
        if not stem[0].isalpha():
            stem = "v3_" + stem
        while True:
            self.seq += 1
            candidate = f"{stem}_{self.seq}"[:32]
            if candidate not in self.reserved and _LABEL_RE.fullmatch(candidate):
                self.reserved.add(candidate)
                return candidate


# ---------------------------------------------------------------------------
# Generic source preparation
# ---------------------------------------------------------------------------


def _strip_comment(line: str) -> str:
    """Remove a ``#`` or ``//`` comment, but only outside JSON strings."""
    out: list[str] = []
    quoted = False
    escaped = False
    i = 0
    while i < len(line):
        ch = line[i]
        if quoted:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                quoted = False
            i += 1
            continue
        if ch == '"':
            quoted = True
            out.append(ch)
            i += 1
            continue
        if ch == "#":
            break
        if ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
            break
        out.append(ch)
        i += 1
    return "".join(out).rstrip()


def _delimiter_delta(text: str) -> int:
    quoted = False
    escaped = False
    depth = 0
    for ch in text:
        if quoted:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                quoted = False
            continue
        if ch == '"':
            quoted = True
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
    return depth


def logical_lines(src: str) -> list[str]:
    r"""Join physical lines into logical statements.

    Comments are stripped, blank lines dropped, a trailing ``\\`` continues a line, and a line
    that leaves a bracket open continues until it closes.  A trailing ``;`` is removed.

    Args:
        src: v3 source text.

    Returns:
        The statements, one string each.

    Raises:
        AlcorLangV3Error: On a closing bracket with no opener, or a statement still open at
            the end of the source.
    """
    physical = src.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    result: list[str] = []
    buf = ""
    depth = 0
    start_line = 1
    for line_no, raw in enumerate(physical, 1):
        clean = _strip_comment(raw)
        if not buf and not clean.strip():
            continue
        if not buf:
            start_line = line_no
        continuation = clean.rstrip().endswith("\\")
        if continuation:
            clean = clean.rstrip()[:-1]
        buf = (buf + " " + clean.strip()).strip() if buf else clean.strip()
        depth += _delimiter_delta(clean)
        if depth < 0:
            raise AlcorLangV3Error(f"line {line_no}: unbalanced delimiter")
        if depth == 0 and not continuation:
            if buf.endswith(";"):
                buf = buf[:-1].rstrip()
            if buf:
                result.append(buf)
            buf = ""
    if buf or depth:
        raise AlcorLangV3Error(f"line {start_line}: unterminated statement or delimiter")
    return result


def reserved_labels(lines: Sequence[str]) -> set[str]:
    """Return the label names the source already defines, so generated labels avoid them."""
    found: set[str] = set()
    for line in lines:
        m = re.match(r"\s*LABEL\s+([a-z][a-z0-9_]{0,31})\s*\Z", line, re.I)
        if m:
            found.add(m.group(1).lower())
    return found


def reserved_cells(lines: Sequence[str]) -> set[str]:
    """Return source cell names without ``$`` for compiler-name hygiene.

    A match inside an inert string merely reserves an extra name, which is safe.
    The conservative scan ensures generated loop-control cells cannot alias any
    cell the source can name.
    """
    found: set[str] = set()
    for line in lines:
        found.update(
            match.group(0)[1:].lower() for match in re.finditer(r"\$[a-z][a-z0-9_]{0,31}", line)
        )
    return found


def jsonable(value: Any) -> Any:
    """Convert directive values to plain JSON types, turning token references into data."""
    if isinstance(value, TokenRef):
        return {"token_ref": "alcor." + value.name}
    if isinstance(value, list):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in sorted(value.items())}
    return value
