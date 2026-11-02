"""Run programs on the AlcorLang interpreter that is itself written in AlcorLang.

``selfhost/alcorlang.alcor`` is an AlcorLang v2 interpreter written in AlcorLang v2.  It reads
one input tape (the guest program, then the guest's own input) and writes the output tape the
reference interpreter would write for that guest.  This module frames that tape, runs the host
on the reference interpreter, and compares the two answers, which is how the self-hosted
interpreter is tested: a construct counts as hosted only when it is accepted and rejected
identically.

Two ways to frame the tape (the host accepts both):

* **count** (used here): the first line is ``%%ALCOR%% <source-line-count> [<budget>]``, then
  exactly that many source lines, then the guest's input.  Unambiguous even when the guest's
  own text contains a ``%%END%%`` line.
* **sentinel** (hand-written): source lines, a line that is exactly ``%%END%%``, then input.

What the host refuses on purpose (it prints a first line starting ``UNSUPPORTED``): embedded v1
effects, INCLUDE and ``fuel=N`` for N above zero.  See ``docs/SELFHOST.md`` for the full list.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .context import ExecutionContext
from .core import transpile
from .errors import AlcorLangError
from .machine import run, run_metered

_SELFHOST_DIR = Path(__file__).resolve().parents[1] / "selfhost"
HOST_PATH = _SELFHOST_DIR / "alcorlang.alcor"
LIBRARY_PATH = _SELFHOST_DIR / "alcorstr.alcor"

# The host declares unbounded fuel, which is the honest setting for an interpreter.  Running it
# through ``run_metered`` with a ceiling keeps a harness run bounded anyway: the caller sets the
# ceiling, not the source.
DEFAULT_HOST_FUEL = 60_000_000
# The guest statement budget the host enforces on its own (it reports HOST-STEP-LIMIT).
DEFAULT_GUEST_BUDGET = 100_000

_LIBRARY_BLOCKS = re.compile(r"^PROGRAM (?:Str|Ns|Pair).*?^END PROGRAM$", re.MULTILINE | re.DOTALL)
_REFUSAL_PREFIXES = ("COMPILE-ERROR", "UNSUPPORTED", "REFUSED")


def host_source() -> str:
    """Return the text of the self-hosted interpreter."""
    return HOST_PATH.read_text(encoding="utf-8")


def make_tape(guest_src: str, guest_input: str = "", budget: int = DEFAULT_GUEST_BUDGET) -> str:
    """Frame a guest program and its input as the host's count-framed tape.

    Args:
        guest_src: The guest program.
        guest_input: Text the guest will READ.
        budget: The most guest statements the host will execute before it stops the guest.

    Returns:
        The tape text.
    """
    lines = guest_src.splitlines()
    header = f"%%ALCOR%% {len(lines)} {budget}\n"
    return header + "".join(line + "\n" for line in lines) + guest_input


@dataclass(frozen=True)
class HostRun:
    """The outcome of running a guest on the self-hosted interpreter.

    Attributes:
        tape: What the host wrote.
        steps: ALCORCORE instructions the reference interpreter spent running the host.
        trapped: The reference interpreter's trap code for the host itself, if any (for
            example ``fuel_exhausted`` when the harness ceiling was reached).
    """

    tape: str
    steps: int
    trapped: str | None


def run_on_host(
    guest_src: str,
    guest_input: str = "",
    *,
    budget: int = DEFAULT_GUEST_BUDGET,
    fuel: int = DEFAULT_HOST_FUEL,
) -> HostRun:
    """Run a guest on the self-hosted interpreter, under a ceiling on the host's own steps.

    Args:
        guest_src: The guest program.
        guest_input: Text the guest will READ.
        budget: The host's own limit on guest statements.
        fuel: Ceiling on the reference interpreter's steps while it runs the host.

    Returns:
        The host's tape and what it cost.
    """
    metered = run_metered(host_source(), make_tape(guest_src, guest_input, budget), fuel=fuel)
    return HostRun(tape=metered["tape"], steps=metered["steps"], trapped=metered["trap"])


def _discard_gate(seq: int, descriptor: dict[str, Any], resolved: dict[str, Any]) -> dict[str, Any]:
    """Answer every effect with a refusal and write nothing.

    The comparison is about the output tape.  The default conformance gate would also write a
    receipt file into the current directory for every effect, which a harness should not do.
    """
    return {"outcome": "refused", "reason_code": "comparison_only"}


@dataclass(frozen=True)
class Verdict:
    """The comparison between the reference interpreter and the self-hosted one.

    Attributes:
        kind: ``identical`` (same tape), ``both-reject`` (the reference raised and the host
            printed a refusal), ``refused-by-design`` (the host printed ``UNSUPPORTED`` for
            something it does not host) or ``mismatch`` (anything else, which is a bug).
        reference: The reference tape, or the rejection message.
        hosted: The host's tape.
        host_steps: Reference-interpreter steps spent running the host.
    """

    kind: str
    reference: str
    hosted: str
    host_steps: int

    @property
    def agrees(self) -> bool:
        """Whether this verdict is acceptable (anything but a mismatch)."""
        return self.kind != "mismatch"


def compare(
    guest_src: str,
    guest_input: str = "",
    *,
    budget: int = DEFAULT_GUEST_BUDGET,
    fuel: int = DEFAULT_HOST_FUEL,
) -> Verdict:
    """Run a guest on both interpreters and say whether they agree.

    A guest the reference rejects must be refused by the host too, because accepting it would
    silently widen the language.  A guest the host marks ``UNSUPPORTED`` is a stated boundary,
    not a disagreement.

    The host hosts the v2 core.  A v3 guest is lowered to v2 by the (Python) frontend first,
    exactly as ``run`` does, so both sides see the same program.
    """
    hosted = run_on_host(transpile(guest_src), guest_input, budget=budget, fuel=fuel)
    quiet = ExecutionContext.conformance(gate_adapter=_discard_gate)
    try:
        reference = run(guest_src, guest_input, context=quiet)
    except AlcorLangError as exc:
        kind = "both-reject" if hosted.tape.startswith(_REFUSAL_PREFIXES) else "mismatch"
        return Verdict(kind, str(exc), hosted.tape, hosted.steps)
    if reference == hosted.tape:
        return Verdict("identical", reference, hosted.tape, hosted.steps)
    if hosted.tape.startswith("UNSUPPORTED"):
        return Verdict("refused-by-design", reference, hosted.tape, hosted.steps)
    return Verdict("mismatch", reference, hosted.tape, hosted.steps)


# Ten typed operands: integers (zero, one, negative, small), strings (empty, one character,
# several characters, one that parses as an integer) and booleans (spelled as comparisons,
# because the language has no boolean literal).
SWEEP_OPERANDS = ("0", "1", "-7", "2", '""', '"a"', '"abc"', '"-12"', "EQ 1 1", "EQ 1 0")
# Every binary operator and every unary operator in the language.
_ARITHMETIC_AND_STRING_OPS = ("ADD", "SUB", "MUL", "DIV", "MOD", "CAT", "CHAR", "FIND")
_COMPARISON_AND_LOGIC_OPS = ("EQ", "NE", "LT", "LE", "GT", "GE", "AND", "OR")
SWEEP_BINARY_OPS = _ARITHMETIC_AND_STRING_OPS + _COMPARISON_AND_LOGIC_OPS
SWEEP_UNARY_OPS = ("NEG", "LEN", "STR", "INT", "NOT")


def operator_sweep() -> Iterator[str]:
    """Yield one tiny guest program per (operator, operand...) combination.

    Every binary operator over every ordered pair of the ten operands, and every unary operator
    over every operand: 16 x 10 x 10 + 5 x 10 = 1650 programs.  Ill-typed combinations are
    included on purpose, because the traps are part of the semantics being compared.
    """
    for op in SWEEP_BINARY_OPS:
        for left in SWEEP_OPERANDS:
            for right in SWEEP_OPERANDS:
                yield f"PROGRAM\nEMIT {op} {left} {right}\nEND PROGRAM\n"
    for op in SWEEP_UNARY_OPS:
        for operand in SWEEP_OPERANDS:
            yield f"PROGRAM\nEMIT {op} {operand}\nEND PROGRAM\n"


def sweep(stride: int = 1) -> tuple[Counter[str], list[tuple[str, Verdict]]]:
    """Compare the two interpreters on the operator sweep.

    Args:
        stride: Take every ``stride``-th program (1 runs all 1650).

    Returns:
        ``(counts by verdict kind, the mismatches)``.
    """
    counts: Counter[str] = Counter()
    mismatches: list[tuple[str, Verdict]] = []
    for index, guest in enumerate(operator_sweep()):
        if index % stride:
            continue
        verdict = compare(guest)
        counts[verdict.kind] += 1
        if not verdict.agrees:
            mismatches.append((guest, verdict))
    return counts, mismatches


def library_blocks(text: str) -> str:
    """Extract the string-library blocks (``Str*``, ``Ns*``, ``Pair*``) from a source text."""
    return "\n".join(_LIBRARY_BLOCKS.findall(text))


def library_in_sync() -> bool:
    """Check that the interpreter carries a byte-identical copy of the string library.

    ``alcorlang.alcor`` cannot INCLUDE ``alcorstr.alcor`` (INCLUDE needs a filesystem door and
    a library is judged at the default profile, so it could never loop), so it embeds a copy.
    The copy must match, and this must hold before either file changes.

    Returns:
        True if both files hold the same non-empty library region.
    """
    host = library_blocks(host_source())
    library = library_blocks(LIBRARY_PATH.read_text(encoding="utf-8"))
    return bool(host) and host == library
