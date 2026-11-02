r"""AlcorLang: a small, fail-closed language for agent policies and kernel programs.

A program is a set of ``PROGRAM`` blocks over named cells.  The default profile can only
describe finite DAGs, so every default program provably halts; loops and recursion exist, but
only under an authority-gated ``complete`` profile with a fuel budget.  Effects are never
performed by the language: an embedded v1 statement becomes one EFFECT instruction that a host
gate answers, and every attempt leaves a receipt.

The pipeline is ``transpile`` (v3 syntax to v2), ``parse`` (lex, parse, static checks),
``compile_core`` (the ALCORCORE instruction list), then ``run`` (interpreter) or
``lower_python`` / ``lower_c`` (code generation).

Typical use::

    import alcorlang

    alcorlang.run('PROGRAM\nEMIT CAT "hello, " "world"\nEND PROGRAM\n')   # 'hello, world\n'
"""

from __future__ import annotations

from .checks import DEFAULT_FUEL, entry_props
from .context import EffectLifecycle, ExecutionContext, InMemoryLifecycle
from .core import Core, compile_core, parse, transpile
from .errors import AlcorLangError, Trap
from .hosted import run_hosted
from .lowering import lower_c, lower_python
from .machine import run, run_metered, run_traced
from .receipts import effect_request_bytes, effect_result, effect_result_bytes, gate_not_wired
from .vocabulary import table

__all__ = [
    "DEFAULT_FUEL",
    "AlcorLangError",
    "Core",
    "EffectLifecycle",
    "ExecutionContext",
    "InMemoryLifecycle",
    "Trap",
    "compile_core",
    "effect_request_bytes",
    "entry_props",
    "effect_result",
    "effect_result_bytes",
    "gate_not_wired",
    "lower_c",
    "lower_python",
    "parse",
    "run",
    "run_hosted",
    "run_metered",
    "run_traced",
    "table",
    "transpile",
]
