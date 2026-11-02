"""AlcorLang v3: structured syntax and portable directives over the v2 core.

v3 does not add a second runtime.  ``transpile`` lowers a v3 source to canonical v2 source, and
every other function here transpiles first and then hands the result to the v2 core, so the
interpreter, the Python and C lowerings, the profiles and the effect gate are the ones v2 has.

A source is v3 only when its first meaningful line is ``ALCOR 3``, ``ALCORLANG 3`` or
``#!ALCOR 3``.  Anything else is returned byte for byte, so older programs never change meaning.
"""

from __future__ import annotations

import importlib
from types import ModuleType
from typing import Any

from .common import VERSION, AlcorLangV3Error, Directive, TokenRef, logical_lines
from .directives import parse_directives
from .expr import compile_expression, parse_expression
from .frontend import transpile

__all__ = [
    "VERSION",
    "AlcorLangV3Error",
    "Directive",
    "TokenRef",
    "compile_core",
    "compile_expression",
    "expand",
    "logical_lines",
    "lower_c",
    "lower_python",
    "parse",
    "parse_directives",
    "parse_expression",
    "run",
    "transpile",
]

# `expand` is a readable alias; `transpile` is the name the specification uses.
expand = transpile

_RUNTIME: ModuleType | None = None


def _runtime() -> ModuleType:
    """Return the module that exposes the v2 core, importing it on first use.

    The import is late because the core imports this package to lower v3 sources, and an
    eager import here would make the two import each other.
    """
    global _RUNTIME
    if _RUNTIME is None:
        _RUNTIME = importlib.import_module("..", __package__)
    return _RUNTIME


def parse(src: str, base_dir: str | None = None) -> dict[str, Any]:
    """Transpile, then return the checked v2 AST."""
    lowered = transpile(src)
    if base_dir is None:
        return _runtime().parse(lowered)
    return _runtime().parse(lowered, base_dir=base_dir)


def compile_core(src: str, base_dir: str | None = None) -> Any:
    """Transpile, then compile to ALCORCORE."""
    lowered = transpile(src)
    if base_dir is None:
        return _runtime().compile_core(lowered)
    return _runtime().compile_core(lowered, base_dir=base_dir)


def run(src: str, input_text: str = "", base_dir: str | None = None) -> str:
    """Transpile, then run on the v2 interpreter and return its output tape."""
    lowered = transpile(src)
    if base_dir is None:
        return _runtime().run(lowered, input_text)
    return _runtime().run(lowered, input_text, base_dir=base_dir)


def lower_python(src: str, base_dir: str | None = None) -> str:
    """Transpile, then lower to standalone Python source."""
    lowered = transpile(src)
    if base_dir is None:
        return _runtime().lower_python(lowered)
    return _runtime().lower_python(lowered, base_dir=base_dir)


def lower_c(src: str, base_dir: str | None = None) -> str:
    """Transpile, then lower to C source."""
    lowered = transpile(src)
    if base_dir is None:
        return _runtime().lower_c(lowered)
    return _runtime().lower_c(lowered, base_dir=base_dir)
