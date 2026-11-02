"""The ALCORCORE interpreter (spec section 6.3) and its run entry points.

``Machine`` executes a compiled ``Core`` with per-frame registers, an output tape and an input
cursor.  A trap stops execution and is written to the tape.  An effect is handed to a gate and
is never performed here.  ``run`` returns exactly what spec section 6.3 fixes (the tape);
``run_metered`` and ``run_traced`` are separate doors so that contract never changes.
"""

from __future__ import annotations

import contextlib
import datetime
import re
import time
from collections.abc import Callable
from typing import Any

from .context import (
    CallbackCapacityExhausted,
    DeadlineExpired,
    ExecutionContext,
    RunBinding,
    binding_projection,
    call_before_deadline,
    parse_future_utc,
)
from .core import Block, Core, compile_core
from .errors import AlcorLangError, Trap
from .receipts import (
    EFFECT_REQUEST_SCHEMA,
    canonical_json_bytes,
    confirmed_terminal_effect,
    decode_effect_result,
    digest_record,
    effect_request_bytes,
    effect_result,
    effect_result_bytes,
    gate_not_wired,
    normal_json,
    sha256_hex,
)
from .syntax import INTERP_RE
from .values import Value, binop, render, truth, unop

# ---------------------------------------------------------------------------
# Interpreter (spec section 6.3).
# ---------------------------------------------------------------------------


class _Frame:
    """One activation: the block being run, its pc, its registers, and where RET delivers."""

    __slots__ = ("block", "pc", "regs", "into")

    def __init__(self, block: Block, regs: dict[str, Value], into: str | None) -> None:
        self.block = block
        self.pc = 0
        self.regs = regs
        self.into = into


class _RuntimeStop(Exception):
    """Execution ended for a reason that is not a trap (a refused or unknown effect)."""

    def __init__(self, outcome: str, reason: str) -> None:
        super().__init__(reason)
        self.outcome = outcome
        self.reason = reason


_CELL_NAME = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


def _bound_cells(cells: dict[str, str] | None) -> dict[str, str]:
    """Validate caller-supplied cells for the entry frame (spec section 6.3).

    READ is not the only way a program can receive input: a host can also bind cells by name,
    for programs that reference ``$cells`` they never READ.  Without this door such a program
    could only ever answer ``TRAP undefined_cell``.

    Validation is strict on purpose.  A silently coerced cell would reintroduce the failure the
    input tape has: a caller whose names drift from the program's gets a wrong answer instead of
    an error.  Names follow the lexer's own rule, so a bound cell and a written ``$cell`` can
    never disagree, and values must already be text.
    """
    if cells is None:
        return {}
    if not isinstance(cells, dict):
        raise AlcorLangError("cells must be a dict of name -> text")
    bound = {}
    for name, value in cells.items():
        if not isinstance(name, str) or _CELL_NAME.match(name) is None:
            raise AlcorLangError(
                f"bad cell name {name!r} (want [a-z][a-z0-9_]{{0,31}}, no $ prefix)"
            )
        if not isinstance(value, str):
            raise AlcorLangError(f"cell ${name} must be text, got {type(value).__name__}")
        bound["$" + name] = value
    return bound


class Machine:
    """Executes one compiled ``Core`` and collects its tape, step count and effect receipts.

    A Machine is single-use: construct it, call ``execute()`` once, then read ``tape``,
    ``steps``, ``trap_code`` and ``runtime_stop``.

    Args:
        core: The compiled program.
        input_text: Text whose lines feed READ.
        context: Host dependencies; defaults to the conformance context.
        binding: The authority decision for a hosted run (``None`` for conformance runs).
        deadline: Monotonic deadline for a hosted run; derived from the context when omitted.
        cells: Entry-frame cells bound by name before the program starts.
    """

    def __init__(
        self,
        core: Core,
        input_text: str = "",
        context: ExecutionContext | None = None,
        binding: RunBinding | None = None,
        deadline: float | None = None,
        cells: dict[str, str] | None = None,
    ) -> None:
        self.core = core
        self.context = context or ExecutionContext.conformance()
        self.binding = binding
        # Seeds the entry frame.  READ still overwrites, so a program may bind some cells
        # and read others.
        self.cells = _bound_cells(cells)
        self.frames: list[_Frame] = []
        self.tape: list[str] = []
        self.lines = input_text.splitlines()
        self.cursor = 0
        self.seq = 0
        self.steps = 0
        self.output_bytes = 0
        self.effect_results: list[dict[str, Any]] = []
        self.effect_replays: list[str] = []
        self.runtime_stop: tuple[str, str] | None = None
        self.trap_code: str | None = None
        self.deadline = (
            None
            if self.context.mode != "hosted"
            else (
                deadline
                if deadline is not None
                else time.monotonic() + self.context.timeout_ms / 1000.0
            )
        )
        # The trace hook: None costs one attribute read per step.
        self._watch: Callable[[_Frame, tuple[Any, ...], int], None] | None = None

    def get(self, reg: str) -> Value:
        """Read a register of the current frame, trapping if a cell was never assigned."""
        try:
            return self.frames[-1].regs[reg]
        except KeyError:
            raise Trap("undefined_cell") from None

    def interpolate(self, text: str | None) -> str | None:
        """Substitute ``$cell`` placeholders in an effect's text (spec section 3).

        The result is inert data: it never re-enters the lexer.
        """
        if text is None or "$" not in text:
            return text
        regs = self.frames[-1].regs

        def sub(match: re.Match[str]) -> str:
            key = "$" + match.group(1)
            if key not in regs:
                raise Trap("undefined_cell")
            return render(regs[key])

        return INTERP_RE.sub(sub, text)

    def output(self) -> str:
        """Return the tape as spec section 6.3 defines it.

        Lines are joined by newlines, with a trailing newline iff the tape is non-empty.
        """
        return ("\n".join(self.tape) + "\n") if self.tape else ""

    def diagnostic_output(self, line: str) -> str:
        """Append a runtime diagnostic only when it fits the hosted tape bound."""
        current = self.output()
        if self.context.mode == "hosted":
            added = len(line.encode("utf-8"))
            if self.output_bytes + added > self.context.max_output_bytes:
                return current
            self.output_bytes += added
        return current + line

    def execute(self) -> str:
        """Run the program to completion and return the output tape.

        Returns:
            The tape as spec section 6.3 defines it.  A trap appends ``TRAP <code>``; a refused
            program returns its refusal line instead of running.
        """
        if self.core.refused() and self.context.mode != "hosted":
            self.runtime_stop = ("refused", "unsigned_complete")
            return "REFUSED unsigned_complete\n"
        if self.context.mode == "hosted" and (self.binding is None or not self.binding.granted):
            reason = (
                self.binding.reason if self.binding is not None else "runtime_authority_missing"
            )
            self.runtime_stop = ("refused", reason)
            return self.diagnostic_output("REFUSED runtime_authority\n")
        self.frames = [_Frame(self.core.entry, dict(self.cells), None)]
        try:
            self._loop()
        except Trap as trap:
            self.trap_code = trap.code
            return self.diagnostic_output(f"TRAP {trap.code}\n")
        except _RuntimeStop as stop:
            self.runtime_stop = (stop.outcome, stop.reason)
        return self.output()

    def _loop(self) -> None:
        fuel = self.core.fuel
        while True:
            frame = self.frames[-1]
            code = frame.block.code
            ins = code[frame.pc] if frame.pc < len(code) else ("RET", None)
            pc_before = frame.pc
            frame.pc += 1
            self.steps += 1
            if self.deadline is not None and time.monotonic() > self.deadline:
                raise _RuntimeStop("unknown", "runtime_timeout")
            watch = self._watch
            if watch is not None:
                watch(frame, ins, pc_before)
            if fuel and self.steps > fuel:
                raise Trap("fuel_exhausted")
            op = ins[0]
            if op == "CONST":
                frame.regs[ins[1]] = ins[2]
            elif op == "MOV":
                frame.regs[ins[1]] = self.get(ins[2])
            elif op == "BINOP":
                frame.regs[ins[2]] = binop(ins[1], self.get(ins[3]), self.get(ins[4]))
            elif op == "UNOP":
                frame.regs[ins[2]] = unop(ins[1], self.get(ins[3]))
            elif op == "JMP":
                frame.pc = ins[1]
            elif op == "JZ":
                if not truth(self.get(ins[1])):
                    frame.pc = ins[2]
            elif op == "IO":
                if ins[1] == "emit":
                    rendered = render(self.get(ins[3]))
                    if self.context.mode == "hosted":
                        added = len(rendered.encode("utf-8")) + 1
                        if self.output_bytes + added > self.context.max_output_bytes:
                            raise _RuntimeStop("refused", "output_limit_exceeded")
                        self.output_bytes += added
                    self.tape.append(rendered)
                else:
                    if self.cursor >= len(self.lines):
                        raise Trap("input_exhausted")
                    frame.regs[ins[2]] = self.lines[self.cursor]
                    self.cursor += 1
            elif op == "EFFECT":
                self._effect(ins[1], ins[2])
            elif op == "CALL":
                regs = {"$" + cell: self.get(reg) for cell, reg in ins[2]}
                target = self.core.blocks.get(ins[1])
                if target is None:
                    raise AlcorLangError(f"CALL target {ins[1]!r} not found")
                self.frames.append(_Frame(target, regs, ins[3]))
            elif op == "RET":
                value = self.get(ins[1]) if ins[1] else 0
                done = self.frames.pop()
                if not self.frames:
                    return
                if done.into:
                    self.frames[-1].regs[done.into] = value
            elif op == "HALT":
                return
            else:
                raise AlcorLangError(f"unknown ALCORCORE instruction {op!r}")

    def _effect(self, descriptor: dict[str, Any], dst: str | None) -> None:
        # Resolve interpolation for the adapter's benefit, but hand the RAW
        # descriptor to the receipt: §8.4 forbids interpolated content there.
        resolved = {
            "value": self.interpolate(descriptor["value_raw"]),
            "props": {k: self.interpolate(v) for k, v in descriptor["props_raw"].items()},
        }
        if self.context.mode == "hosted":
            result = self._hosted_effect(descriptor, resolved)
            self.effect_results.append(result)
            if result["outcome"] != "complete":
                raise _RuntimeStop(result["outcome"], result["reason_code"])
        else:
            gate = self.context.gate_adapter or gate_not_wired
            receipt = gate(self.seq, descriptor, resolved)
            sink = self.context.receipt_sink
            if callable(sink):
                sink(receipt)
            self.seq += 1
        if dst:
            self.frames[-1].regs[dst] = 0

    def _hosted_effect(
        self, descriptor: dict[str, Any], resolved: dict[str, Any]
    ) -> dict[str, Any]:
        context = self.context
        binding = self.binding
        identity = {
            "correlation_id": context.correlation_id,
            "idempotency_sha256": context.idempotency_sha256,
            "sequence": self.seq,
        }
        request_id = "effect-" + sha256_hex(canonical_json_bytes(identity))[:40]
        request = {
            "schema": EFFECT_REQUEST_SCHEMA,
            "request_id": request_id,
            "correlation_id": context.correlation_id,
            "sequence": self.seq,
            "idempotency_sha256": context.idempotency_sha256,
            "run_binding_sha256": binding_projection(binding, context)["binding_sha256"],
            "descriptor": normal_json(descriptor),
            "resolved": normal_json(resolved),
        }
        request["request_sha256"] = digest_record(request, "request_sha256")
        try:
            request_raw = effect_request_bytes(request)
        except AlcorLangError:
            return effect_result(request, "refused", "effect_request_invalid", attempted=False)
        self.seq += 1

        try:
            parse_future_utc(binding.valid_until_utc)
        except AlcorLangError:
            return effect_result(request, "refused", "runtime_authority_expired", attempted=False)

        lifecycle = context.lifecycle
        gate = context.gate_adapter
        if (
            lifecycle is None
            or not callable(getattr(lifecycle, "lookup", None))
            or not callable(getattr(lifecycle, "mark_attempted", None))
            or not callable(getattr(lifecycle, "finish", None))
        ):
            return effect_result(request, "refused", "lifecycle_not_wired", attempted=False)
        if not callable(gate):
            return effect_result(request, "refused", "effect_gate_not_wired", attempted=False)

        try:
            existing = call_before_deadline(lifecycle.lookup, (request_id,), self.deadline)
        except CallbackCapacityExhausted:
            return effect_result(
                request, "refused", "lifecycle_lookup_capacity_exhausted", attempted=False
            )
        except DeadlineExpired:
            return effect_result(request, "refused", "lifecycle_lookup_timeout", attempted=False)
        except Exception:
            return effect_result(request, "refused", "lifecycle_lookup_failed", attempted=False)
        replay = self._existing_effect(request, existing, replay_lookup=True)
        if replay is not None:
            return replay

        binding_view = binding_projection(binding, context)
        try:
            raced = call_before_deadline(
                lifecycle.mark_attempted, (request_raw, dict(binding_view)), self.deadline
            )
        except CallbackCapacityExhausted:
            return effect_result(
                request,
                "refused",
                "attempt_callback_capacity_exhausted",
                effect_started=False,
                attempted=False,
            )
        except DeadlineExpired as exc:
            if not exc.started:
                return effect_result(
                    request,
                    "refused",
                    "attempt_deadline_elapsed",
                    effect_started=False,
                    attempted=False,
                )
            # The callback is still in flight and may persist after this run
            # returns.  A point-in-time empty lookup cannot prove that it will
            # not do so, hence UNKNOWN/no replay is the only safe result.
            try:
                settled = call_before_deadline(lifecycle.lookup, (request_id,), self.deadline)
            except Exception:
                settled = None
            reconciled = self._existing_effect(request, settled, replay_lookup=False)
            if reconciled is not None:
                return reconciled
            return effect_result(
                request,
                "unknown",
                "attempt_persist_unconfirmed",
                effect_started=False,
                attempted=True,
            )
        except Exception:
            # The callback finished by raising.  Reconcile a possible
            # commit-then-raise; if an exact lookup confirms absence, no effect
            # attempt exists and the request is safely refused rather than
            # falsely labelled ATTEMPTED.
            lookup_confirmed = False
            try:
                settled = call_before_deadline(lifecycle.lookup, (request_id,), self.deadline)
                lookup_confirmed = True
            except Exception:
                settled = None
            reconciled = self._existing_effect(request, settled, replay_lookup=False)
            if reconciled is not None:
                return reconciled
            if lookup_confirmed:
                return effect_result(
                    request,
                    "refused",
                    "attempt_persist_failed",
                    effect_started=False,
                    attempted=False,
                )
            return effect_result(
                request,
                "unknown",
                "attempt_persist_unconfirmed",
                effect_started=False,
                attempted=True,
            )
        replay = self._existing_effect(request, raced, replay_lookup=True)
        if replay is not None:
            return replay

        try:
            authority_until = parse_future_utc(binding.valid_until_utc)
        except AlcorLangError:
            result = effect_result(
                request,
                "refused",
                "runtime_authority_expired",
                effect_started=False,
                attempted=True,
            )
        else:
            authority_seconds = max(
                0.0,
                (authority_until - datetime.datetime.now(datetime.timezone.utc)).total_seconds(),
            )
            remaining = max(0.0, self.deadline - time.monotonic())
            settlement_reserve = min(0.25, remaining * 0.20)
            effect_deadline = min(
                self.deadline - settlement_reserve,
                time.monotonic() + authority_seconds,
            )
            try:
                raw_result = call_before_deadline(gate, (request_raw,), effect_deadline)
                result = decode_effect_result(raw_result, request)
                if result["attempted"] is not True:
                    raise AlcorLangError("a called hosted gate must acknowledge ATTEMPTED")
            except CallbackCapacityExhausted:
                result = effect_result(
                    request,
                    "refused",
                    "effect_callback_capacity_exhausted",
                    effect_started=False,
                    attempted=True,
                )
            except DeadlineExpired as exc:
                if exc.started:
                    result = effect_result(
                        request,
                        "unknown",
                        "effect_boundary_timeout",
                        effect_started=True,
                        attempted=True,
                    )
                else:
                    result = effect_result(
                        request,
                        "refused",
                        "effect_deadline_elapsed",
                        effect_started=False,
                        attempted=True,
                    )
            except Exception:
                result = effect_result(
                    request,
                    "unknown",
                    "effect_boundary_ambiguous",
                    effect_started=True,
                    attempted=True,
                )

        result_raw = effect_result_bytes(result, request)
        terminal_confirmed = False
        try:
            call_before_deadline(lifecycle.finish, (result_raw, dict(binding_view)), self.deadline)
            terminal_confirmed = True
        except Exception:
            # The store may have committed and then lost its acknowledgement.
            # Reconcile once; never issue a second, conflicting terminal write.
            try:
                settled = call_before_deadline(lifecycle.lookup, (request_id,), self.deadline)
            except Exception:
                settled = None
            reconciled = confirmed_terminal_effect(settled, request)
            if reconciled is not None:
                result = reconciled
                terminal_confirmed = True
            else:
                # ATTEMPTED was durably recorded before the gate. An unconfirmed
                # terminal is UNKNOWN to this process and is never retried; the
                # canonical store owns recovery to a durable UNKNOWN receipt.
                result = effect_result(
                    request,
                    "unknown",
                    "terminal_persist_unconfirmed",
                    effect_started=result["effect_started"],
                    effect_committed=result["effect_committed"],
                    postcondition_verified=result["postcondition_verified"],
                    attempted=True,
                    result_sha256=result["result_sha256"],
                )
            result_raw = effect_result_bytes(result, request)
        sink = context.receipt_sink
        if terminal_confirmed and callable(sink):
            with contextlib.suppress(Exception):
                call_before_deadline(sink, (result_raw,), self.deadline)
        return result

    def _existing_effect(
        self, request: dict[str, Any], existing: object, replay_lookup: bool = False
    ) -> dict[str, Any] | None:
        if existing is None:
            return None
        if type(existing) is bytes:
            result = confirmed_terminal_effect(existing, request)
            if result is not None:
                if replay_lookup:
                    self.effect_replays.append(request["request_id"])
                return result
            return effect_result(request, "refused", "effect_replay_conflict", attempted=False)
        if type(existing) is not dict:
            return effect_result(request, "refused", "effect_replay_invalid", attempted=False)
        stored_sha = existing.get("request_sha256")
        if type(stored_sha) is not str or stored_sha != request["request_sha256"]:
            return effect_result(request, "refused", "effect_replay_conflict", attempted=False)
        stored_state = existing.get("state")
        if type(stored_state) is not str:
            return effect_result(request, "refused", "effect_replay_invalid", attempted=False)
        state = stored_state.lower()
        if state == "attempted":
            if replay_lookup:
                self.effect_replays.append(request["request_id"])
            return effect_result(
                request,
                "unknown",
                "existing_attempted_no_replay",
                effect_started=False,
                attempted=True,
            )
        result = confirmed_terminal_effect(existing, request)
        if result is not None:
            if replay_lookup:
                self.effect_replays.append(request["request_id"])
            return result
        return effect_result(request, "refused", "effect_replay_invalid", attempted=False)


def run(
    src: str,
    input_text: str = "",
    base_dir: str | None = None,
    context: ExecutionContext | None = None,
    cells: dict[str, str] | None = None,
) -> str:
    """Execute a program and return its output tape (spec section 6.3).  Never prints.

    The tape is the emitted lines joined by newlines, with a trailing newline iff the tape is
    non-empty.  A trap appends ``TRAP <code>``; a ``complete`` program without authority
    returns exactly ``REFUSED unsigned_complete``.

    Args:
        src: v1, v2 or v3 source.
        input_text: Text whose lines feed READ.
        base_dir: The include root; ``None`` forbids INCLUDE.
        context: A conformance context to inject a gate or receipt sink.  Hosted contexts
            must use ``run_hosted``.
        cells: Cells bound by name in the entry frame, for programs that reference ``$cells``
            they never READ.

    Returns:
        The output tape.

    Raises:
        AlcorLangError: If the source is rejected at compile time.
    """
    if context is not None and context.mode == "hosted":
        raise AlcorLangError("hosted contexts must use run_hosted()")
    return Machine(compile_core(src, base_dir), input_text, context=context, cells=cells).execute()


def run_traced(
    src: str,
    input_text: str = "",
    fuel: int | None = None,
    base_dir: str | None = None,
    max_steps: int = 2000,
    context: ExecutionContext | None = None,
    cells: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run a program and record every instruction with the frame's cells after it.

    A step is recorded after the instruction executes, so the cell values shown are the ones
    that instruction produced, which is what someone stepping through a program wants to see.
    The trace is capped at ``max_steps`` because a trace is for reading.

    Args:
        src: v1, v2 or v3 source.
        input_text: Text whose lines feed READ.
        fuel: Override the step cap (at least 1); ``None`` keeps the program's own.
        base_dir: The include root.
        max_steps: How many steps to record.
        context: A conformance context.
        cells: Cells bound by name in the entry frame.

    Returns:
        ``{"tape", "steps", "truncated", "total_steps", "trap"}``.
    """
    core = compile_core(src, base_dir)
    if fuel is not None:
        core = core.with_fuel(max(1, int(fuel)))
    if context is not None and context.mode == "hosted":
        raise AlcorLangError("hosted contexts must use run_hosted()")
    machine = Machine(core, input_text, context=context, cells=cells)
    steps: list[dict[str, Any]] = []

    def watch(frame: _Frame, ins: tuple[Any, ...], pc_before: int) -> None:
        if len(steps) < max_steps:
            steps.append(
                {
                    "n": len(steps),
                    "pc": pc_before,
                    "op": ins[0],
                    "ins": [render(x) if isinstance(x, (int, str)) else str(x) for x in ins[1:]],
                    "block": frame.block.name or "<entry>",
                    "cells": {k: render(v) for k, v in frame.regs.items() if k.startswith("$")},
                    "tape_len": len(machine.tape),
                }
            )

    machine._watch = watch
    tape = machine.execute()
    trap = machine.trap_code
    return {
        "tape": tape,
        "steps": steps,
        "truncated": len(steps) >= max_steps,
        "total_steps": machine.steps,
        "trap": trap,
    }


def run_metered(
    src: str,
    input_text: str = "",
    fuel: int | None = None,
    base_dir: str | None = None,
    context: ExecutionContext | None = None,
    cells: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run a program and report what it cost as well as what it printed.

    Spec section 6.3 fixes what ``run`` returns (the tape and nothing else), so this is a
    second door rather than a change to that one.  It exists because fuel was a bound nobody
    could read: a program either finished or came back ``TRAP fuel_exhausted``, with no way to
    ask how close a finished program came to the wall.

    ``fuel`` overrides the program's own declaration, which is what makes an untrusted
    complete-profile program safe to host: the caller sets the ceiling, not the source.
    ``fuel=0`` (unbounded) is deliberately not reachable by override; pass ``None`` to honour
    the program's own setting.

    Args:
        src: v1, v2 or v3 source.
        input_text: Text whose lines feed READ.
        fuel: A step ceiling of at least 1, or ``None``.
        base_dir: The include root.
        context: A conformance context.
        cells: Cells bound by name in the entry frame.

    Returns:
        ``{"tape", "steps", "fuel", "profile", "trap", "exhausted", "headroom"}``.

    Raises:
        AlcorLangError: If the source is rejected, or ``fuel`` is below 1.
    """
    core = compile_core(src, base_dir)
    if fuel is not None:
        fuel = int(fuel)
        if fuel < 1:
            raise AlcorLangError(
                "an override fuel must be at least 1; pass None to honour the program's own setting"
            )
        # A copy: the compiled Core is cached and shared, so overriding its fuel in place
        # would change every later run of the same source.
        core = core.with_fuel(fuel)
    if context is not None and context.mode == "hosted":
        raise AlcorLangError("hosted contexts must use run_hosted()")
    machine = Machine(core, input_text, context=context, cells=cells)
    tape = machine.execute()
    trap = machine.trap_code
    if machine.runtime_stop is not None:
        trap = "refused:" + machine.runtime_stop[1]
    return {
        "tape": tape,
        "steps": machine.steps,
        "fuel": core.fuel,
        "profile": core.profile,
        "trap": trap,
        "exhausted": trap == "fuel_exhausted",
        "headroom": (None if not core.fuel else max(0, core.fuel - machine.steps)),
    }
