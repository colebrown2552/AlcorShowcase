"""The policy front door: ask a finite ``.alcor`` program for a decision, then bind the decision.

The pattern behind every gate in AlcorCLI is the same and lives here once:

1. The host computes *cells*: plain facts such as ``inside_root=no`` or ``fast_state=up``. Facts
   that need arithmetic or I/O (resolve a path, probe a port) are the host's job, never the
   program's.
2. The program, a short ``.alcor`` file with no I/O, answers with ``key=value`` lines. It can
   branch on cells and emit text; it cannot run a command or open a file.
3. The host obeys. If the program cannot be found, cannot run, or emits something unexpected,
   that is *unavailable*, and unavailable is deny. A program that could not answer is not a
   program that said no.

Every answer comes back with a receipt over the exact program bytes, the exact cell values and
the exact decision, so a later reader can check that a decision came from this source and these
inputs. The receipt proves reproducibility, not that a caller-supplied fact was true.

The ``.alcor`` interpreter itself is not part of AlcorCLI. It is the sibling ``alcorlang``
package of this repository, loaded by ``load_runtime``; tests may inject any object with a
compatible ``run`` method.
"""

from __future__ import annotations

import importlib
import re
import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .digest import sha256_hex
from .errors import PolicyError

PROGRAM_DIR = Path(__file__).resolve().parent / "programs"
PACKAGE_PARENT = Path(__file__).resolve().parent.parent
ENVELOPE_SCHEMA = "alcor.program.v1"
RECEIPT_SCHEMA = "alcor.program.decision-receipt.v1"

_READ_RE = re.compile(r"^\s*READ\s+\$([a-z][a-z0-9_]{0,31})\s*$", re.M)
_PROGRAM_RE = re.compile(r"^PROGRAM\s+([A-Za-z0-9_]+)(?:\s+WITH\s+profile=([a-z]+))?", re.M)
_SCHEMA_RE = re.compile(r'EMIT\s+"schema=([A-Za-z0-9._-]+)"')
_TRAP_RE = re.compile(r"\bTRAP\s+([A-Za-z0-9_]+)")


class ProgramUnavailable(PolicyError):
    """The program or the runtime could not be reached."""

    status = "unavailable"


class ProgramRefused(PolicyError):
    """The program answered the host, not the question: cells missing, schema mismatch."""

    status = "refused"


class ProgramFault(PolicyError):
    """The runtime raised or the program trapped."""

    status = "error"


class Runtime(Protocol):
    """What the policy host needs from an ``.alcor`` interpreter."""

    def run(self, source: str, input_text: str = "", base_dir: str | None = None) -> str:
        """Run ``source`` with one input line per ``READ`` and return the output tape."""
        ...


class ModuleRuntime:
    """Adapts the sibling ``alcorlang`` module to the ``Runtime`` protocol."""

    def __init__(self, module: Any) -> None:
        self._module = module

    def run(self, source: str, input_text: str = "", base_dir: str | None = None) -> str:
        """Run a program and return its output tape as text."""
        result = self._module.run(source, input_text=input_text, base_dir=base_dir)
        return result if isinstance(result, str) else str(getattr(result, "output", result))

    def check(self, source: str, base_dir: str | None = None) -> None:
        """Parse and statically check a program. Raises if either step fails.

        ``parse`` already runs the static checks in current ``alcorlang``. A layout that keeps a
        separate ``static_check`` gets it called on the parsed module as well.
        """
        module = self._module.parse(source, base_dir=base_dir)
        static_check = getattr(self._module, "static_check", None)
        if callable(static_check):
            static_check(module)

    def can_check(self) -> bool:
        """True when the module exposes a parser."""
        return callable(getattr(self._module, "parse", None))


def load_runtime() -> ModuleRuntime:
    """Import the sibling ``alcorlang`` package and wrap its ``run`` function.

    The first attempt uses whatever is already importable (an installed package, or the
    repository root on ``sys.path``). The second adds ``<repository>/AlcorLang`` for the layout
    where the interpreter is a module inside that folder.

    Raises:
        ProgramUnavailable: If no importable ``alcorlang`` exposes ``run``.
    """
    failure = "no module named alcorlang"
    for attempt in range(2):
        if attempt == 1:
            sibling = PACKAGE_PARENT.parent / "AlcorLang"
            if sibling.is_dir() and str(sibling) not in sys.path:
                sys.path.insert(0, str(sibling))
            # Drop a namespace-package shell left by the first attempt so the module is found.
            sys.modules.pop("alcorlang", None)
        for name in ("alcorlang", "alcorlang.alcorlang"):
            try:
                module = importlib.import_module(name)
            except ImportError as exc:
                failure = str(exc)[:160]
                continue
            if callable(getattr(module, "run", None)):
                return ModuleRuntime(module)
    raise ProgramUnavailable("alcorlang-not-importable", failure)


def read_order(source: str) -> list[str]:
    """Return the cell names a program READs, in order.

    The tape is positional, so this order is the contract between host and program.
    """
    return _READ_RE.findall(source)


def parse_emitted(text: str) -> dict[str, str]:
    """Split emitted ``key=value`` lines into a dict.

    A duplicate key is an error, not "last one wins": two hosts that disagree about what a
    decision means are worse than either rule.

    Raises:
        ProgramRefused: On a line that is not ``key=value`` or on a repeated key.
    """
    decision: dict[str, str] = {}
    for line in str(text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ProgramRefused("emitted-line-is-not-key-value", line[:60])
        key, _, value = line.partition("=")
        key = key.strip()
        if key in decision:
            raise ProgramRefused("emitted-duplicate-key", key)
        decision[key] = value.strip()
    return decision


def _operational_cells(cells: Mapping[str, Any]) -> dict[str, str]:
    """Normalise cell names and values to the strings the program will see.

    Booleans become ``true``/``false`` (not Python's ``True``), and a value with a line break is
    refused: the tape is one value per line, so a newline would shift every later cell.
    """
    normalised: dict[str, str] = {}
    for raw_name, raw_value in dict(cells).items():
        name = str(raw_name)
        if name in normalised:
            raise ProgramRefused("cell-names-collide", name)
        value = (
            ("true" if raw_value else "false") if isinstance(raw_value, bool) else str(raw_value)
        )
        if "\n" in value or "\r" in value:
            raise ProgramRefused("cell-value-has-line-break", name)
        normalised[name] = value
    return normalised


def _trap_code(text: str) -> str:
    match = _TRAP_RE.search(str(text or ""))
    return match.group(1) if match else ""


@dataclass(frozen=True)
class Decision:
    """One verified answer from a program.

    Attributes:
        fields: The emitted ``key=value`` pairs, verbatim.
        receipt: The decision receipt (program, input and decision hashes).
        program: Identity of the program that answered.
    """

    fields: Mapping[str, str]
    receipt: Mapping[str, Any]
    program: str

    def get(self, key: str, default: str = "") -> str:
        """Return an emitted field, or ``default`` when the program did not emit it."""
        return self.fields.get(key, default)

    def __getitem__(self, key: str) -> str:
        return self.fields[key]


class PolicyHost:
    """Consults ``.alcor`` programs and binds each answer to its inputs.

    Args:
        runtime: An interpreter. Defaults to the sibling ``alcorlang`` package, loaded lazily.
        programs_dir: Where program names are resolved.
        root: Programs under this directory are reported as ``repository`` scope; others as
            ``external``, identified by file name only.
    """

    def __init__(
        self,
        runtime: Runtime | None = None,
        *,
        programs_dir: Path = PROGRAM_DIR,
        root: Path = PACKAGE_PARENT,
    ) -> None:
        self._runtime = runtime
        self.programs_dir = Path(programs_dir)
        self.root = Path(root)

    def runtime(self) -> Runtime:
        """Return the interpreter, loading the sibling package on first use."""
        if self._runtime is None:
            self._runtime = load_runtime()
        return self._runtime

    def find_program(self, name: str | Path) -> Path:
        """Resolve a program name or path.

        Raises:
            ProgramUnavailable: If no such program exists.
        """
        candidate = Path(name)
        if candidate.suffix != ".alcor":
            candidate = Path(str(name) + ".alcor")
        if candidate.is_absolute() or candidate.parent != Path("."):
            if candidate.is_file():
                return candidate
            raise ProgramUnavailable("program-not-found", candidate.name)
        found = self.programs_dir / candidate.name
        if found.is_file():
            return found
        raise ProgramUnavailable("program-not-found", candidate.name)

    def identity(self, program: Path) -> tuple[str, str]:
        """Return ``(program id, scope)``. Bytes carry identity; an absolute path adds nothing."""
        try:
            return program.resolve().relative_to(self.root.resolve()).as_posix(), "repository"
        except ValueError:
            return program.name, "external"

    def _consult(
        self, program: Path, source: str, cells: dict[str, str], expect_schema: str
    ) -> dict[str, str]:
        order = read_order(source)
        if not order:
            raise ProgramRefused("program-has-no-read-statements", program.name)
        missing = [name for name in order if name not in cells]
        if missing:
            # Named, not positional: the failure says which cell, instead of shifting the tape.
            raise ProgramRefused("cells-not-supplied", ", ".join(missing))
        tape = "\n".join(cells[name] for name in order)
        try:
            emitted = self.runtime().run(source, input_text=tape, base_dir=str(program.parent))
        except PolicyError:
            raise
        except Exception as exc:
            code = _trap_code(str(exc))
            raise ProgramFault(
                "program-trapped" if code else "runtime-error", str(exc)[:200]
            ) from exc
        if emitted.lstrip().startswith("TRAP"):
            raise ProgramFault("program-trapped", emitted.strip().splitlines()[0][:80])
        decision = parse_emitted(emitted)
        if not decision:
            raise ProgramRefused("program-emitted-no-decision", program.name)
        if expect_schema and decision.get("schema") != expect_schema:
            raise ProgramRefused(
                "decision-schema-mismatch",
                f"got {decision.get('schema')!r}, wanted {expect_schema!r}",
            )
        return decision

    def receipt_for(
        self,
        program: Path,
        source_bytes: bytes,
        cells: Mapping[str, str],
        expect_schema: str,
        decision: Mapping[str, str],
    ) -> dict[str, Any]:
        """Build the decision receipt over the program bytes, the cells and the decision."""
        program_id, scope = self.identity(program)
        contract = {"cells": dict(cells), "door": "tape", "expect_schema": expect_schema}
        return {
            "schema": RECEIPT_SCHEMA,
            "program": program_id,
            "program_scope": scope,
            "program_sha256": sha256_hex(source_bytes),
            "input_sha256": sha256_hex(contract),
            "decision_sha256": sha256_hex(dict(decision)),
            "effect_authority": False,
        }

    def run(
        self, name: str | Path, cells: Mapping[str, Any], expect_schema: str = ""
    ) -> dict[str, Any]:
        """Consult a program. Never raises for a program-side problem.

        Returns:
            An envelope with ``status`` of ``decided`` (carrying ``decision`` and
            ``policy_receipt``), ``refused`` (the program answered the host, not the question),
            ``unavailable`` (program or runtime unreachable) or ``error`` (runtime raised).
        """
        started = time.monotonic()
        envelope: dict[str, Any] = {"schema": ENVELOPE_SCHEMA, "program": str(name)}
        try:
            program = self.find_program(name)
            source_bytes = program.read_bytes()
            source = source_bytes.decode("utf-8")
            normalised = _operational_cells(cells)
            decision = self._consult(program, source, normalised, expect_schema)
            if program.read_bytes() != source_bytes:
                # Never hash one source and execute another.
                raise ProgramFault("program-source-changed-during-decision", program.name)
            receipt = self.receipt_for(program, source_bytes, normalised, expect_schema, decision)
        except PolicyError as exc:
            status = getattr(exc, "status", "error")
            envelope.update(ok=False, status=status, error=f"{exc.code}: {exc.detail}"[:300])
        except (OSError, UnicodeError) as exc:
            envelope.update(ok=False, status="unavailable", error=type(exc).__name__)
        else:
            envelope.update(
                ok=True,
                status="decided",
                door="tape",
                decision=decision,
                policy_receipt=receipt,
                unread_cells=sorted(set(normalised) - set(read_order(source))),
            )
        envelope["ms"] = int((time.monotonic() - started) * 1000)
        return envelope

    def decide(self, name: str | Path, cells: Mapping[str, Any], expect_schema: str) -> Decision:
        """Consult a program and verify its receipt against what this host sent.

        Raises:
            PolicyError: If the program did not decide, or its receipt does not match the
                program bytes, the cells or the decision. Callers treat that as deny.
        """
        envelope = self.run(name, cells, expect_schema)
        if not isinstance(envelope, Mapping):
            raise PolicyError("envelope-malformed")
        if envelope.get("status") != "decided":
            raise PolicyError(f"program-{envelope.get('status')}", str(envelope.get("error", "")))
        program = self.find_program(name)
        return self.verify(envelope, program=program, cells=cells, expect_schema=expect_schema)

    def verify(
        self,
        envelope: Mapping[str, Any],
        *,
        program: Path,
        cells: Mapping[str, Any],
        expect_schema: str,
    ) -> Decision:
        """Recompute every hash in an envelope's receipt and compare.

        This is the check a consumer runs before it obeys a decision it did not compute itself.
        """
        if (
            envelope.get("schema") != ENVELOPE_SCHEMA
            or envelope.get("ok") is not True
            or envelope.get("status") != "decided"
        ):
            raise PolicyError("envelope-did-not-decide")
        decision = envelope.get("decision")
        if not isinstance(decision, Mapping) or decision.get("schema") != expect_schema:
            raise PolicyError("decision-schema-mismatch")
        if decision.get("effect_authority") != "false":
            raise PolicyError("decision-claimed-authority")
        receipt = envelope.get("policy_receipt")
        if not isinstance(receipt, Mapping) or receipt.get("schema") != RECEIPT_SCHEMA:
            raise PolicyError("receipt-missing")
        if receipt.get("effect_authority") is not False:
            raise PolicyError("receipt-claimed-authority")
        program_id, scope = self.identity(program)
        if receipt.get("program") != program_id or receipt.get("program_scope") != scope:
            raise PolicyError("receipt-program-mismatch")
        if receipt.get("program_sha256") != sha256_hex(program.read_bytes()):
            raise PolicyError("receipt-source-mismatch")
        if envelope.get("door") != "tape":
            raise PolicyError("receipt-door-invalid")
        contract = {
            "cells": _operational_cells(cells),
            "door": "tape",
            "expect_schema": expect_schema,
        }
        if receipt.get("input_sha256") != sha256_hex(contract):
            raise PolicyError("receipt-input-mismatch")
        if receipt.get("decision_sha256") != sha256_hex(dict(decision)):
            raise PolicyError("receipt-decision-mismatch")
        return Decision(fields=dict(decision), receipt=dict(receipt), program=program_id)

    def check(self, name: str | Path) -> dict[str, Any]:
        """Parse and statically check a program without running it."""
        out: dict[str, Any] = {"schema": ENVELOPE_SCHEMA, "program": str(name), "ok": False}
        try:
            program = self.find_program(name)
            source = program.read_text(encoding="utf-8")
        except (PolicyError, OSError, UnicodeError) as exc:
            out.update(status="unavailable", error=str(exc)[:200])
            return out
        out["cells"] = read_order(source)
        out["schemas"] = sorted(set(_SCHEMA_RE.findall(source)))
        out["programs"] = [
            {"name": m.group(1), "profile": m.group(2) or "default"}
            for m in _PROGRAM_RE.finditer(source)
        ]
        try:
            runtime = self.runtime()
        except PolicyError as exc:
            out.update(status="unavailable", error=f"{exc.code}: {exc.detail}"[:200])
            return out
        checker = getattr(runtime, "check", None)
        if not callable(checker) or not getattr(runtime, "can_check", lambda: False)():
            out.update(status="unavailable", error="runtime-has-no-static-checker")
            return out
        try:
            checker(source, str(program.parent))
        except Exception as exc:
            out.update(status="rejected", error=str(exc)[:300])
            return out
        out.update(ok=True, status="clean")
        return out

    def programs(self) -> list[dict[str, Any]]:
        """List the shipped programs with their identity, cells and decision schemas."""
        rows = []
        for path in sorted(self.programs_dir.glob("*.alcor")):
            source = path.read_text(encoding="utf-8")
            rows.append(
                {
                    "name": path.stem,
                    "sha256": sha256_hex(path.read_bytes()),
                    "cells": read_order(source),
                    "schemas": sorted(set(_SCHEMA_RE.findall(source))),
                }
            )
        return rows
