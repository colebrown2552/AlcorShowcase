"""Exception types shared by every stage of the AlcorLang pipeline.

Two kinds of failure exist and they are kept apart on purpose.  ``AlcorLangError`` is a
compile-time rejection: the program is not legal, nothing ran, and the message names the
reason.  ``Trap`` is a run-time stop defined by the language (spec section 6.3): the program
was legal and ran, then hit a case the language defines as a stop (division by zero, a wrong
type, a missing cell).  A trap never escapes ``run()``; it becomes a ``TRAP <code>`` line on
the output tape.
"""

from __future__ import annotations

# The closed set of run-time trap codes (spec section 6.3).
TRAP_CODES = frozenset(
    {
        "div_zero",
        "mod_zero",
        "type_mismatch",
        "undefined_cell",
        "bad_int",
        "input_exhausted",
        "fuel_exhausted",
    }
)


class AlcorLangError(Exception):
    """A compile-time rejection.  Fail-closed: the message names the reason."""


class Trap(Exception):
    """A run-time trap (spec section 6.3) carrying one code from ``TRAP_CODES``.

    Args:
        code: The trap code.

    Raises:
        ValueError: If ``code`` is not a member of ``TRAP_CODES``.  A new trap must be added
            to the closed set (and the spec) before the interpreter may raise it.
    """

    def __init__(self, code: str) -> None:
        if code not in TRAP_CODES:
            raise ValueError(f"unknown trap code {code!r}")
        super().__init__(code)
        self.code = code
