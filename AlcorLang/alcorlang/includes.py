"""INCLUDE: splice a library file into a program before the lexer runs (spec section 12).

Every edge fails closed.  A library is judged alone, as a default-profile module of named,
prop-free blocks, before it may join the includer.  An INCLUDE can therefore never raise a
profile, smuggle authority or fuel, or bring a loop.
"""

from __future__ import annotations

import os
import re
from typing import Any

from .checks import static_check
from .errors import AlcorLangError
from .syntax import Parser, lex

# INCLUDE is textual and resolved before the lexer runs.  A library is judged ALONE before it
# may touch the includer: parsed as a standalone module, every block named, every block bare of
# props.  A module with no entry props is default-profile, so the library is provably halting
# whatever includes it.

# An INCLUDE line: the whole line, so the word inside a string or a statement is not a match.
INCLUDE_RE = re.compile(r'^[ \t]*INCLUDE[ \t]+"([^"\r\n]*)"[ \t]*\r?$', re.MULTILINE)
_INCLUDE_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,59}\.alcor$")

# Limits that bound a hostile or accidental include graph.
MAX_INCLUDE_BYTES = 65536  # per library file
MAX_INCLUDE_DEPTH = 4
MAX_INCLUDE_TOTAL = 262144  # cumulative text inserted at splice points
MAX_INCLUDE_COUNT = 64  # include-line occurrences in one expansion


class _IncludeResolver:
    """Resolve one compilation with independent validation and final emission.

    Validation proves every library from its own root and complete dependency
    closure. Final emission is compilation-global and canonical-path-idempotent,
    so a diamond contributes a shared dependency once. An active-stack repeat is
    still a cycle and is rejected before idempotence is considered.

    ``raw_cache`` pins the first bytes read for each canonical path. Validation
    and emission therefore cannot observe different file contents if a library
    changes concurrently during a compilation.
    """

    def __init__(self, base_dir: str | None) -> None:
        self.root = None if base_dir is None else os.path.realpath(base_dir)
        self.raw_cache = {}
        self.validated = set()
        self.emitted = set()
        self.final_budget = {"bytes": 0, "count": 0}

    def resolve(self, src: str, seen: frozenset[str] = frozenset(), depth: int = 0) -> str:
        return self._splice_final(src, set(seen), depth)

    def _resolve_path(self, name: str, active: set[str], depth: int) -> str:
        if depth > MAX_INCLUDE_DEPTH:
            raise AlcorLangError(f"INCLUDE nested deeper than {MAX_INCLUDE_DEPTH}")
        if self.root is None:
            raise AlcorLangError(
                f'INCLUDE "{name}": the host granted no include root. A program handed to '
                "run() as bare text may not read the filesystem by mentioning a "
                "filename."
            )
        if not _INCLUDE_NAME_RE.match(name):
            raise AlcorLangError(
                f'INCLUDE "{name}": a library name is a bare .alcor filename -- '
                "lowercase, no path separators, no dots except the extension"
            )
        path = os.path.realpath(os.path.join(self.root, name))
        if os.path.normcase(os.path.dirname(path)) != os.path.normcase(self.root):
            # The name regex already forbids separators; this catches symlink escape.
            raise AlcorLangError(f'INCLUDE "{name}" escaped its directory')
        if path in active:
            raise AlcorLangError(f'INCLUDE cycle at "{name}"')
        return path

    def _read_raw(self, name: str, path: str) -> str:
        if path in self.raw_cache:
            return self.raw_cache[path]
        try:
            # Read at most one byte past the cap from one open file. This both
            # bounds the read and establishes the immutable per-compilation view.
            with open(path, "rb") as fh:
                raw = fh.read(MAX_INCLUDE_BYTES + 1)
        except OSError:
            raise AlcorLangError(f'INCLUDE "{name}": no such library beside the program') from None
        if len(raw) > MAX_INCLUDE_BYTES:
            raise AlcorLangError(
                f'INCLUDE "{name}": {len(raw)} bytes is past the '
                f"{MAX_INCLUDE_BYTES}-byte library cap"
            )
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise AlcorLangError(f'INCLUDE "{name}": library is not valid UTF-8') from None
        self.raw_cache[path] = text
        return text

    @staticmethod
    def _charge_matches(src: str, budget: dict[str, int]) -> None:
        budget["count"] += len(INCLUDE_RE.findall(src))
        if budget["count"] > MAX_INCLUDE_COUNT:
            raise AlcorLangError(f"more than {MAX_INCLUDE_COUNT} INCLUDE lines in one compilation")

    @staticmethod
    def _charge_text(text: str, budget: dict[str, int]) -> None:
        if not text:
            return
        budget["bytes"] += len(text.encode("utf-8"))
        if budget["bytes"] > MAX_INCLUDE_TOTAL:
            raise AlcorLangError(
                f"INCLUDE expansion past the {MAX_INCLUDE_TOTAL}-byte total budget"
            )

    @staticmethod
    def _check_library(name: str, text: str) -> None:
        module = static_check(Parser(lex(text)).parse_module())
        for item in module["body"]:
            if item["type"] != "program":
                raise AlcorLangError(
                    f'INCLUDE "{name}": a library holds only PROGRAM blocks; a bare v1 '
                    "statement has no meaning there"
                )
            if not item["name"]:
                raise AlcorLangError(
                    f'INCLUDE "{name}": every library block must be named, or it could '
                    "never be CALLed"
                )
            if item["props"]:
                raise AlcorLangError(
                    f'INCLUDE "{name}": a library block declares no props -- profile, '
                    "fuel and authority belong to the program that includes it"
                )

    def _validate(self, name: str, path: str, active: set[str], depth: int) -> None:
        # Cycle truth precedes cache reuse. Otherwise a validated-path hit could
        # hide the same path recurring on the current active include stack.
        if path in active:
            raise AlcorLangError(f'INCLUDE cycle at "{name}"')
        if path in self.validated:
            return
        state = {"emitted": set(), "budget": {"bytes": 0, "count": 0}}
        text = self._expand_validation(name, active, depth, state)
        self._check_library(name, text)
        # Mark only the root just judged. A child must never inherit names from
        # the parent that happened to include it.
        self.validated.add(path)

    def _expand_validation(
        self, name: str, active: set[str], depth: int, state: dict[str, Any]
    ) -> str:
        path = self._resolve_path(name, active, depth)
        if path in state["emitted"]:
            return ""
        state["emitted"].add(path)
        raw = self._read_raw(name, path)
        return self._splice_validation(raw, active | {path}, depth + 1, state)

    def _splice_validation(
        self, src: str, active: set[str], depth: int, state: dict[str, Any]
    ) -> str:
        if "INCLUDE" not in src:
            return src
        self._charge_matches(src, state["budget"])

        def sub(match: re.Match[str]) -> str:
            child_name = match.group(1)
            child_path = self._resolve_path(child_name, active, depth)
            # Prove the child alone before sharing its definitions with this
            # parent's validation namespace.
            self._validate(child_name, child_path, active, depth)
            text = self._expand_validation(child_name, set(active), depth, state)
            self._charge_text(text, state["budget"])
            return ("\n" + text + "\n") if text else ""

        return INCLUDE_RE.sub(sub, src)

    def _expand_final(self, name: str, active: set[str], depth: int) -> str:
        path = self._resolve_path(name, active, depth)
        self._validate(name, path, active, depth)
        if path in self.emitted:
            return ""
        self.emitted.add(path)
        raw = self._read_raw(name, path)
        return self._splice_final(raw, active | {path}, depth + 1)

    def _splice_final(self, src: str, active: set[str], depth: int) -> str:
        if "INCLUDE" not in src:
            return src
        self._charge_matches(src, self.final_budget)

        def sub(match: re.Match[str]) -> str:
            text = self._expand_final(match.group(1), set(active), depth)
            self._charge_text(text, self.final_budget)
            return ("\n" + text + "\n") if text else ""

        return INCLUDE_RE.sub(sub, src)


def splice_includes(
    src: str, base_dir: str | None, seen: frozenset[str] = frozenset(), depth: int = 0
) -> str:
    """Resolve INCLUDE as a cycle-safe, canonical-path-idempotent graph."""
    return _IncludeResolver(base_dir).resolve(src, seen=seen, depth=depth)
