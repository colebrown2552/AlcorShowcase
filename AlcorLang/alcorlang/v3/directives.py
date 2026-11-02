"""Parser and validator for the portable ``.alcor.*`` directives.

A directive describes intent (run this model, translate this source) and grants no authority.
It is parsed as strict JSON-like data, validated in stages (lexical, grammar, closed token set,
source semantics) and lowered to one embedded v1 statement, which the v2 core turns into one
EFFECT instruction for the host gate to judge.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable
from typing import Any

from .common import (
    ACTION_DIRECTIVES,
    BINDING_DIRECTIVES,
    DIRECTIVES,
    MAX_CONTEXT_INPUT,
    MAX_CONTEXT_OUTPUT,
    MAX_DIRECTIVE_DEPTH,
    MAX_DIRECTIVE_ITEMS,
    MAX_DIRECTIVE_STRING,
    MAX_DIRECTIVES,
    QUERY_DIRECTIVES,
    REQUIRED_VALUE,
    SECRET_KEYS,
    THREAD_RE,
    AlcorLangV3Error,
    Directive,
    DirectiveState,
    DTok,
    TokenRef,
)


def _scan_directive(text: str) -> list[DTok]:
    toks: list[DTok] = []
    i = 0
    decoder = json.JSONDecoder()
    while i < len(text):
        ch = text[i]
        if ch.isspace() or ch == ";":
            i += 1
            continue
        if text.startswith(".alcor.", i):
            m = re.match(r"\.alcor\.([A-Za-z][A-Za-z0-9_-]{0,31})", text[i:])
            if not m:
                raise AlcorLangV3Error(f"column {i + 1}: malformed .alcor token")
            name = m.group(1).lower()
            toks.append(DTok("directive", name, i))
            i += len(m.group(0))
            continue
        if ch == '"':
            try:
                value, used = decoder.raw_decode(text[i:])
            except json.JSONDecodeError as exc:
                raise AlcorLangV3Error(f"column {i + 1}: invalid JSON string: {exc.msg}") from None
            if not isinstance(value, str):
                raise AlcorLangV3Error(f"column {i + 1}: expected string")
            toks.append(DTok("value", value, i))
            i += used
            continue
        number = re.match(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", text[i:])
        if number:
            raw = number.group(0)
            value: int | float = float(raw) if any(c in raw for c in ".eE") else int(raw)
            if isinstance(value, float) and not math.isfinite(value):
                raise AlcorLangV3Error("directive number must be finite")
            toks.append(DTok("value", value, i))
            i += len(raw)
            continue
        ident = re.match(r"[A-Za-z_][A-Za-z0-9_-]*", text[i:])
        if ident:
            raw = ident.group(0)
            low = raw.lower()
            if low == "true":
                toks.append(DTok("value", True, i))
            elif low == "false":
                toks.append(DTok("value", False, i))
            elif low == "null":
                toks.append(DTok("value", None, i))
            else:
                toks.append(DTok("ident", raw, i))
            i += len(raw)
            continue
        if ch in "()[]{},:=":
            toks.append(DTok(ch, ch, i))
            i += 1
            continue
        raise AlcorLangV3Error(f"column {i + 1}: unexpected character {ch!r}")
    toks.append(DTok("eof", None, len(text)))
    return toks


class _DirectiveParser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.toks = _scan_directive(text)
        self.i = 0

    def peek(self, kind: str | None = None, offset: int = 0) -> DTok | bool:
        tok = self.toks[min(self.i + offset, len(self.toks) - 1)]
        return tok if kind is None else tok.kind == kind

    def take(self, kind: str) -> DTok:
        tok = self.toks[self.i]
        if tok.kind != kind:
            raise AlcorLangV3Error(f"column {tok.pos + 1}: expected {kind!r}, got {tok.kind!r}")
        self.i += 1
        return tok

    def parse_all(self) -> list[Directive]:
        out: list[Directive] = []
        while not self.peek("eof"):
            out.append(self.parse_directive())
        return out

    def parse_directive(self) -> Directive:
        name = str(self.take("directive").value).lower()
        if name not in DIRECTIVES:
            raise AlcorLangV3Error(f"unknown .alcor directive {name!r}; fail-closed")
        args: list[Any] = []
        kwargs: dict[str, Any] = {}
        saw_keyword = False
        if self.peek("("):
            self.take("(")
            if not self.peek(")"):
                while True:
                    if self.peek("ident") and self.peek("=", 1):
                        saw_keyword = True
                        key = str(self.take("ident").value)
                        self.take("=")
                        if key in kwargs:
                            raise AlcorLangV3Error(f"duplicate directive argument {key!r}")
                        kwargs[key] = self.parse_value(1)
                    else:
                        if saw_keyword:
                            tok = self.peek()
                            assert isinstance(tok, DTok)
                            raise AlcorLangV3Error(
                                f"column {tok.pos + 1}: positional directive arguments "
                                "cannot follow keyword arguments"
                            )
                        args.append(self.parse_value(1))
                    if self.peek(","):
                        self.take(",")
                        if self.peek(")"):
                            raise AlcorLangV3Error("trailing directive comma is not allowed")
                        continue
                    break
            self.take(")")
        return Directive(name, tuple(args), kwargs)

    def parse_value(self, depth: int) -> Any:
        if depth > MAX_DIRECTIVE_DEPTH:
            raise AlcorLangV3Error("directive value nesting exceeds limit")
        tok = self.peek()
        assert isinstance(tok, DTok)
        if tok.kind == "value":
            self.i += 1
            if isinstance(tok.value, str) and len(tok.value) > MAX_DIRECTIVE_STRING:
                raise AlcorLangV3Error("directive string exceeds limit")
            return tok.value
        if tok.kind == "ident":
            # Small symbolic atoms such as auto/local/cheap are strings. They are
            # deliberately not executable names.
            self.i += 1
            return str(tok.value)
        if tok.kind == "directive":
            self.i += 1
            return TokenRef(str(tok.value).lower())
        if tok.kind == "[":
            self.take("[")
            values: list[Any] = []
            if not self.peek("]"):
                while True:
                    values.append(self.parse_value(depth + 1))
                    if len(values) > MAX_DIRECTIVE_ITEMS:
                        raise AlcorLangV3Error("directive array exceeds item limit")
                    if self.peek(","):
                        self.take(",")
                        continue
                    break
            self.take("]")
            return values
        if tok.kind == "{":
            self.take("{")
            values: dict[str, Any] = {}
            if not self.peek("}"):
                while True:
                    key_tok = self.peek()
                    assert isinstance(key_tok, DTok)
                    if key_tok.kind not in {"value", "ident"} or not isinstance(key_tok.value, str):
                        raise AlcorLangV3Error(
                            f"column {key_tok.pos + 1}: object key must be a string or identifier"
                        )
                    self.i += 1
                    key = str(key_tok.value)
                    if key in values:
                        raise AlcorLangV3Error(f"duplicate object key {key!r}")
                    self.take(":")
                    values[key] = self.parse_value(depth + 1)
                    if len(values) > MAX_DIRECTIVE_ITEMS:
                        raise AlcorLangV3Error("directive object exceeds item limit")
                    if self.peek(","):
                        self.take(",")
                        continue
                    break
            self.take("}")
            return values
        raise AlcorLangV3Error(f"column {tok.pos + 1}: expected directive value")


def parse_directives(text: str) -> list[Directive]:
    """Parse one or more ``.alcor.*`` directives from a line and validate their shape.

    Args:
        text: One logical line, for example ``.alcor.model("local") .alcor.status()``.

    Returns:
        The directives in source order.

    Raises:
        AlcorLangV3Error: On a lexical or grammar error, an unknown directive name (fail
            closed), a duplicate or misplaced argument, a credential-shaped key, a malformed
            ``.alcor.thread`` id, or an out-of-range context limit.
    """
    directives = _DirectiveParser(text).parse_all()
    for directive in directives:
        _validate_directive_shape(directive)
    return directives


def _walk_values(value: Any, path: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], Any]]:
    yield path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _walk_values(child, path + (str(key),))
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            yield from _walk_values(child, path + (str(index),))


def _is_secret_key(raw: str) -> bool:
    key = raw.lower().replace("-", "_")
    if key in SECRET_KEYS:
        return True
    parts = tuple(part for part in key.split("_") if part)
    sensitive = {"secret", "password", "authorization", "cookie", "credential"}
    if any(part in sensitive for part in parts):
        return True
    if "token" in parts or key.endswith("token") or key.startswith("token_"):
        return True
    return bool(key.endswith("api_key") or key.endswith("private_key"))


def _validate_v2_string(value: str) -> None:
    """Reject strings the canonical v2 lexer cannot represent losslessly."""
    for ch in value:
        code = ord(ch)
        if 0xD800 <= code <= 0xDFFF:
            raise AlcorLangV3Error("directive string contains an invalid surrogate code point")
        if code < 32 and ch not in {"\n", "\t", "\r"}:
            raise AlcorLangV3Error(
                f"directive string contains unsupported control character U+{code:04X}"
            )


def _value_resolved(value: Any, state: DirectiveState) -> bool:
    if isinstance(value, TokenRef):
        return value.name in state.bound
    if isinstance(value, list):
        return all(_value_resolved(child, state) for child in value)
    if isinstance(value, dict):
        return all(_value_resolved(child, state) for child in value.values())
    return True


def _require_resolved_refs(directive: Directive, state: DirectiveState) -> None:
    for _, value in _walk_values({"args": directive.args, "kwargs": directive.kwargs}):
        if isinstance(value, TokenRef) and value.name not in state.bound:
            raise AlcorLangV3Error(
                f".alcor.{directive.name} references unbound token .alcor.{value.name}"
            )


def _explicit_or_bound(
    directive: Directive,
    key: str,
    state: DirectiveState,
    positional_index: int | None = None,
) -> bool:
    if key in state.bound:
        return True
    if key in directive.kwargs:
        return _value_resolved(directive.kwargs[key], state)
    if positional_index is not None and len(directive.args) > positional_index:
        return _value_resolved(directive.args[positional_index], state)
    return False


def _validate_directive_shape(directive: Directive) -> None:
    if directive.name not in DIRECTIVES:
        raise AlcorLangV3Error(f"unknown .alcor directive {directive.name!r}")
    if len(directive.args) + len(directive.kwargs) > MAX_DIRECTIVE_ITEMS:
        raise AlcorLangV3Error("directive has too many arguments")
    if directive.name in REQUIRED_VALUE and not directive.args and not directive.kwargs:
        raise AlcorLangV3Error(f".alcor.{directive.name} requires a value")

    for path, value in _walk_values({"args": directive.args, "kwargs": directive.kwargs}):
        if path and _is_secret_key(path[-1]):
            raise AlcorLangV3Error(
                f"credential-like field {path[-1]!r} is forbidden in .alcor source"
            )
        if isinstance(value, TokenRef) and value.name not in DIRECTIVES:
            raise AlcorLangV3Error(f"unknown token reference .alcor.{value.name}")
        if isinstance(value, str):
            if len(value) > MAX_DIRECTIVE_STRING:
                raise AlcorLangV3Error("directive string exceeds limit")
            _validate_v2_string(value)

    if directive.name == "thread":
        positional_shape = len(directive.args) == 1 and not directive.kwargs
        keyword_shape = not directive.args and set(directive.kwargs) == {"id"}
        if not (positional_shape or keyword_shape):
            raise AlcorLangV3Error(
                ".alcor.thread accepts exactly one string ID, positional or id=..."
            )
        candidate = directive.args[0] if positional_shape else directive.kwargs["id"]
        if not isinstance(candidate, str):
            raise AlcorLangV3Error(".alcor.thread id must be a literal string")
        if not THREAD_RE.fullmatch(candidate) or ".." in candidate or candidate.startswith("/"):
            raise AlcorLangV3Error("unsafe .alcor.thread id")

    if directive.name == "context":
        for key, limit in (("max_input", MAX_CONTEXT_INPUT), ("max_output", MAX_CONTEXT_OUTPUT)):
            value = directive.kwargs.get(key)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > limit:
                raise AlcorLangV3Error(f".alcor.context {key} must be 0..{limit}")


def apply_directive_semantics(directive: Directive, state: DirectiveState) -> None:
    """Check a directive against the bindings established so far, then record its own.

    Enforces the directive budget, that every token reference is bound on all reaching paths,
    and the per-directive requirements (``run`` needs a model or profile, ``translate`` needs a
    source and a target, ``compile`` needs a target).  The directive's own binding is added only
    after validation, so a directive cannot satisfy its own reference.

    Args:
        directive: The parsed directive.
        state: The bindings and budget for the current control-flow path; updated in place.

    Raises:
        AlcorLangV3Error: If any requirement is not met.
    """
    state.count += 1
    if state.count > MAX_DIRECTIVES:
        raise AlcorLangV3Error("program exceeds directive limit")

    # A token reference is inert data, but "resolved" still means its binding
    # was established on every path reaching this statement. Validate before
    # adding the current directive's own binding so self-reference cannot pass.
    _require_resolved_refs(directive, state)

    if directive.name == "run":
        resolved = _explicit_or_bound(directive, "model", state) or _explicit_or_bound(
            directive, "profile", state
        )
        if not resolved:
            raise AlcorLangV3Error(
                ".alcor.run requires a prior .alcor.model/.alcor.select(profile=...) "
                "or an explicit model/profile argument"
            )
    if directive.name == "translate":
        has_source = _explicit_or_bound(directive, "source", state, 0)
        has_target = _explicit_or_bound(directive, "target", state, 1)
        if not has_source or not has_target:
            raise AlcorLangV3Error(".alcor.translate requires resolved source and target bindings")
    if directive.name == "compile" and not _explicit_or_bound(directive, "target", state, 0):
        raise AlcorLangV3Error(".alcor.compile requires a target")

    if directive.name in BINDING_DIRECTIVES:
        state.bound.add(directive.name)
    if directive.name == "select":
        # A positional selection names a policy alias/profile (for example
        # local or cheap); explicit keys retain their exact binding kind.
        if directive.args:
            state.bound.add("profile")
        if "model" in directive.kwargs:
            state.bound.add("model")
        if "profile" in directive.kwargs:
            state.bound.add("profile")


def directive_to_v2(directive: Directive) -> str:
    """Lower a directive to the one embedded v1 statement that carries it.

    Query directives become ``View Task``; the rest become ``Update Task``.  The payload is
    strict canonical JSON, quoted as a v2 string, with ``directive``, ``schema`` and ``mode``
    properties so the host gate can route it.

    Raises:
        AlcorLangV3Error: If the payload is not strict canonical JSON.
    """
    mode = (
        "query"
        if directive.name in QUERY_DIRECTIVES
        else ("action" if directive.name in ACTION_DIRECTIVES else "bind")
    )
    verb = "View" if mode == "query" else "Update"
    try:
        payload = json.dumps(
            directive.payload(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        value = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        raise AlcorLangV3Error("directive payload is not strict canonical JSON") from None
    return (
        f"{verb} Task {value} WITH directive={directive.name} schema=alcor.directive.v1 mode={mode}"
    )
