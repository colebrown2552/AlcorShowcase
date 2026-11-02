"""Per-run host dependencies: the ExecutionContext, deadlines and the run binding.

``run()`` is the conformance door and carries no authority.  A *hosted* run is configured by an
immutable ``ExecutionContext`` that the host builds, never by program text: limits, an
authority verifier, a lifecycle store and the effect gate.  This module holds that context and
the helpers that keep host callbacks bounded by a deadline.
"""

from __future__ import annotations

import datetime
import json
import queue
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol, TypeAlias

from .errors import AlcorLangError
from .receipts import digest_record, require_hex64, require_safe_id, sha256_hex

EXECUTION_CONTEXT_SCHEMA = "alcor.execution.context.v1"

# Host callbacks.  A conformance gate is called as ``gate(seq, descriptor, resolved)`` and
# returns a receipt dict; a hosted gate is called as ``gate(request_bytes)`` and returns
# canonical result bytes.  A verifier is called as ``verifier(challenge, capsule)`` and returns
# a decision dict.
GateAdapter: TypeAlias = Callable[..., Any]
ReceiptSink: TypeAlias = Callable[[Any], None]
AuthorityVerifier: TypeAlias = Callable[[dict[str, Any], bytes], dict[str, Any]]

# Only the two factory classmethods hold this token, which is how `ExecutionContext(...)` called
# directly from host or program code is refused.
_FACTORY_TOKEN = object()

# At most this many host callbacks may be in flight.  A callback that blocks forever after its
# deadline keeps its daemon thread, so the cap bounds how many such threads a run can leak.
_CALLBACK_CAPACITY = threading.BoundedSemaphore(64)


def parse_future_utc(value: object) -> datetime.datetime:
    """Parse an RFC 3339 UTC timestamp and require that it is still in the future.

    Args:
        value: A string like ``2030-01-02T03:04:05Z``.

    Returns:
        The timestamp as an aware datetime.

    Raises:
        AlcorLangError: If it is not that exact shape, or has already passed.
    """
    if type(value) is not str or not value.endswith("Z"):
        raise AlcorLangError("authority valid_until_utc must be RFC3339 UTC")
    try:
        valid = datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
        valid = valid.replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        raise AlcorLangError("authority valid_until_utc must be RFC3339 UTC") from None
    if valid <= datetime.datetime.now(datetime.timezone.utc):
        raise AlcorLangError("runtime authority has expired")
    return valid


class EffectLifecycle(Protocol):
    """The durable store that makes a hosted effect at-most-once or UNKNOWN, never twice.

    Before the gate is called the runtime persists an ATTEMPTED record.  If the process dies
    afterwards, the next run finds ATTEMPTED and reports UNKNOWN instead of calling the gate
    again, because the effect may or may not have happened.  A real implementation must make
    ``mark_attempted`` atomic and durable; ``InMemoryLifecycle`` is the reference double.

    A record returned by ``lookup`` or ``mark_attempted`` is either ``None``, the raw bytes of
    a terminal result, or a dict with ``request_sha256``, ``state`` and (when terminal)
    ``result`` bytes.
    """

    def lookup(self, request_id: str) -> object:
        """Return the existing record for ``request_id``, or ``None``."""
        ...

    def mark_attempted(self, request_raw: bytes, binding: dict[str, Any]) -> object:
        """Persist ATTEMPTED for this request and return any record that already existed."""
        ...

    def finish(self, result_raw: bytes, binding: dict[str, Any]) -> None:
        """Persist the terminal result for a request previously marked ATTEMPTED."""
        ...


class InMemoryLifecycle:
    """A thread-safe, non-durable ``EffectLifecycle`` for demos and tests.

    It has the same observable behaviour as a durable store while the process lives, which is
    enough to show replay and UNKNOWN handling end to end.  It forgets everything on exit.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, dict[str, Any]] = {}

    def lookup(self, request_id: str) -> object:
        """Return a copy of the record for ``request_id``, or ``None``."""
        with self._lock:
            record = self._records.get(request_id)
            return None if record is None else dict(record)

    def mark_attempted(self, request_raw: bytes, binding: dict[str, Any]) -> object:
        """Persist ATTEMPTED unless a record exists; return the existing one if so."""
        request = json.loads(request_raw)
        with self._lock:
            existing = self._records.get(request["request_id"])
            if existing is not None:
                return dict(existing)
            self._records[request["request_id"]] = {
                "request_sha256": request["request_sha256"],
                "state": "attempted",
                "request": request_raw,
            }
            return None

    def finish(self, result_raw: bytes, binding: dict[str, Any]) -> None:
        """Store the terminal result against its ATTEMPTED record."""
        result = json.loads(result_raw)
        with self._lock:
            record = self._records[result["request_id"]]
            record["state"] = result["outcome"]
            record["result"] = result_raw

    def states(self) -> dict[str, str]:
        """Return ``{request_id: state}`` for every stored record."""
        with self._lock:
            return {rid: record["state"] for rid, record in self._records.items()}


class ExecutionContext:
    """Immutable, per-run host dependencies.  No source text can mint one.

    ``conformance()`` serves the language corpus and accepts the three-argument gate
    signature.  It is explicitly not hosted authority.

    ``hosted()`` accepts only verifier input plus callbacks.  The verifier must bind its
    decision to the run challenge, which is created after parsing and INCLUDE expansion; a
    literal ``authority=conformance`` in the source never satisfies that check.
    """

    __slots__ = (
        "schema",
        "mode",
        "gate_adapter",
        "lifecycle",
        "receipt_sink",
        "correlation_id",
        "idempotency_sha256",
        "source_revision",
        "adapter_revision",
        "authority_capsule",
        "authority_verifier",
        "max_fuel",
        "timeout_ms",
        "max_output_bytes",
        "_sealed",
    )

    def __init__(
        self,
        mode: str,
        gate_adapter: GateAdapter | None = None,
        lifecycle: EffectLifecycle | None = None,
        receipt_sink: ReceiptSink | None = None,
        correlation_id: str | None = None,
        idempotency_sha256: str | None = None,
        source_revision: str | None = None,
        adapter_revision: str | None = None,
        authority_capsule: bytes | None = None,
        authority_verifier: AuthorityVerifier | None = None,
        max_fuel: int | None = None,
        timeout_ms: int | None = None,
        max_output_bytes: int | None = None,
        _factory_token: object | None = None,
    ) -> None:
        if _factory_token is not _FACTORY_TOKEN:
            raise AlcorLangError("ExecutionContext must be created by conformance() or hosted()")
        object.__setattr__(self, "schema", EXECUTION_CONTEXT_SCHEMA)
        object.__setattr__(self, "mode", mode)
        object.__setattr__(self, "gate_adapter", gate_adapter)
        object.__setattr__(self, "lifecycle", lifecycle)
        object.__setattr__(self, "receipt_sink", receipt_sink)
        object.__setattr__(self, "correlation_id", correlation_id)
        object.__setattr__(self, "idempotency_sha256", idempotency_sha256)
        object.__setattr__(self, "source_revision", source_revision)
        object.__setattr__(self, "adapter_revision", adapter_revision)
        object.__setattr__(self, "authority_capsule", authority_capsule)
        object.__setattr__(self, "authority_verifier", authority_verifier)
        object.__setattr__(self, "max_fuel", max_fuel)
        object.__setattr__(self, "timeout_ms", timeout_ms)
        object.__setattr__(self, "max_output_bytes", max_output_bytes)
        object.__setattr__(self, "_sealed", True)

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("ExecutionContext is immutable")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("ExecutionContext is immutable")

    def __repr__(self) -> str:
        return (
            f"ExecutionContext(mode={self.mode!r}, correlation_id={self.correlation_id!r}, "
            f"source_revision={self.source_revision!r}, "
            f"adapter_revision={self.adapter_revision!r})"
        )

    @classmethod
    def conformance(
        cls, gate_adapter: GateAdapter | None = None, receipt_sink: ReceiptSink | None = None
    ) -> ExecutionContext:
        """Build the context used by ``run()``: no authority, an optional gate and sink.

        Args:
            gate_adapter: ``gate(seq, descriptor, resolved)`` returning a receipt; defaults to the
                ``not_wired`` refusal gate.
            receipt_sink: Called with each receipt the gate returns.

        Returns:
            A conformance-mode context.
        """
        return cls(
            "conformance",
            gate_adapter=gate_adapter,
            receipt_sink=receipt_sink,
            _factory_token=_FACTORY_TOKEN,
        )

    @classmethod
    def hosted(
        cls,
        correlation_id: str,
        idempotency_key: str,
        source_revision: str,
        adapter_revision: str,
        max_fuel: int,
        timeout_ms: int,
        max_output_bytes: int,
        authority_capsule: bytes | None = None,
        authority_verifier: AuthorityVerifier | None = None,
        lifecycle: EffectLifecycle | None = None,
        gate_adapter: GateAdapter | None = None,
        receipt_sink: ReceiptSink | None = None,
    ) -> ExecutionContext:
        """Build the context for ``run_hosted()``, validating every limit and identifier.

        Args:
            correlation_id: A bounded identifier tying this run's records together.
            idempotency_key: Non-empty text; the same key replays instead of re-running an effect.
            source_revision: Lowercase SHA-256 of the revision the program came from.
            adapter_revision: Lowercase SHA-256 of the gate adapter build.
            max_fuel: Step ceiling, 1 to 100,000,000; it overrides the program's own ``fuel``.
            timeout_ms: Wall-clock budget, 1 to 60,000.
            max_output_bytes: Cap on the output tape, up to 16 MiB.
            authority_capsule: Opaque bytes handed to the verifier.
            authority_verifier: ``verifier(challenge, capsule)`` returning an authority decision.
            lifecycle: The store that makes effects at-most-once or UNKNOWN.
            gate_adapter: ``gate(request_bytes)`` returning canonical result bytes.
            receipt_sink: Called with each terminal result's bytes.

        Returns:
            A hosted-mode context.

        Raises:
            AlcorLangError: If any argument is out of range or has the wrong type.
        """
        require_safe_id(correlation_id, "correlation_id")
        if type(idempotency_key) is not str or not idempotency_key:
            raise AlcorLangError("idempotency_key must be non-empty text")
        try:
            idempotency_bytes = idempotency_key.encode("utf-8")
        except UnicodeEncodeError:
            raise AlcorLangError("idempotency_key must be strict UTF-8") from None
        if len(idempotency_bytes) > 1024:
            raise AlcorLangError("idempotency_key exceeds 1024 bytes")
        require_hex64(source_revision, "source_revision")
        require_hex64(adapter_revision, "adapter_revision")
        for value, name in (
            (max_fuel, "max_fuel"),
            (timeout_ms, "timeout_ms"),
            (max_output_bytes, "max_output_bytes"),
        ):
            if type(value) is not int:
                raise AlcorLangError(f"hosted {name} must be an integer")
        if not 1 <= max_fuel <= 100000000:
            raise AlcorLangError("hosted max_fuel must be between 1 and 100000000")
        if not 1 <= timeout_ms <= 60000:
            raise AlcorLangError("hosted timeout_ms must be between 1 and 60000")
        if not 0 <= max_output_bytes <= 16 * 1024 * 1024:
            raise AlcorLangError("hosted max_output_bytes exceeds 16 MiB")
        if authority_capsule is not None:
            if type(authority_capsule) is not bytes:
                raise AlcorLangError("authority_capsule must be opaque bytes")
            if len(authority_capsule) > 64 * 1024:
                raise AlcorLangError("authority_capsule exceeds 64 KiB")
        for callback, name in (
            (authority_verifier, "authority_verifier"),
            (gate_adapter, "gate_adapter"),
            (receipt_sink, "receipt_sink"),
        ):
            if callback is not None and not callable(callback):
                raise AlcorLangError(f"{name} must be callable")
        return cls(
            "hosted",
            gate_adapter=gate_adapter,
            lifecycle=lifecycle,
            receipt_sink=receipt_sink,
            correlation_id=correlation_id,
            idempotency_sha256=sha256_hex(idempotency_bytes),
            source_revision=source_revision,
            adapter_revision=adapter_revision,
            authority_capsule=authority_capsule,
            authority_verifier=authority_verifier,
            max_fuel=max_fuel,
            timeout_ms=timeout_ms,
            max_output_bytes=max_output_bytes,
            _factory_token=_FACTORY_TOKEN,
        )


class DeadlineExpired(Exception):
    """A host callback did not answer before the run's deadline.

    ``started`` says whether the callback was already running; if so it may still finish later,
    so its effect must be treated as UNKNOWN.
    """

    def __init__(self, message: str, started: bool = False) -> None:
        Exception.__init__(self, message)
        self.started = bool(started)


class CallbackCapacityExhausted(DeadlineExpired):
    """Too many host callbacks are in flight to start another safely."""

    def __init__(self) -> None:
        DeadlineExpired.__init__(self, "runtime callback capacity exhausted", started=False)


def call_before_deadline(
    callback: Callable[..., Any], args: tuple[Any, ...], deadline: float
) -> Any:
    """Bound one host callback without ever invoking it twice.

    A timed-out callback may still finish in its daemon thread. For the effect
    gate that is intentionally classified UNKNOWN; ATTEMPTED was already
    durable and the returned value is discarded forever.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise DeadlineExpired("runtime deadline elapsed", started=False)
    capacity = _CALLBACK_CAPACITY
    if not capacity.acquire(blocking=False):
        raise CallbackCapacityExhausted()
    answers = queue.Queue(maxsize=1)

    def invoke() -> None:
        try:
            try:
                answer = (True, callback(*args))
            except BaseException as exc:  # callback isolation boundary
                answer = (False, exc)
            answers.put(answer)
        finally:
            capacity.release()

    thread = threading.Thread(target=invoke, daemon=True, name="alcor-runtime-callback")
    try:
        thread.start()
    except BaseException:
        capacity.release()
        raise
    try:
        ok, value = answers.get(timeout=remaining)
    except queue.Empty:
        raise DeadlineExpired("runtime callback deadline elapsed", started=True) from None
    if not ok:
        if isinstance(value, Exception):
            raise value
        raise RuntimeError(f"runtime callback aborted: {type(value).__name__}")
    return value


def _validate_hosted_context(context: object) -> dict[str, Any]:
    if type(context) is not ExecutionContext:
        raise AlcorLangError("run_hosted requires ExecutionContext.hosted()")
    try:
        values = {name: getattr(context, name) for name in ExecutionContext.__slots__}
    except AttributeError:
        raise AlcorLangError("hosted execution context is incomplete") from None
    if (
        type(values["schema"]) is not str
        or values["schema"] != EXECUTION_CONTEXT_SCHEMA
        or type(values["mode"]) is not str
        or values["mode"] != "hosted"
    ):
        raise AlcorLangError("run_hosted requires ExecutionContext.hosted()")
    require_safe_id(values["correlation_id"], "correlation_id")
    require_hex64(values["idempotency_sha256"], "idempotency_sha256")
    require_hex64(values["source_revision"], "source_revision")
    require_hex64(values["adapter_revision"], "adapter_revision")
    if type(values["max_fuel"]) is not int or not 1 <= values["max_fuel"] <= 100000000:
        raise AlcorLangError("hosted max_fuel is invalid")
    if type(values["timeout_ms"]) is not int or not 1 <= values["timeout_ms"] <= 60000:
        raise AlcorLangError("hosted timeout_ms is invalid")
    if (
        type(values["max_output_bytes"]) is not int
        or not 0 <= values["max_output_bytes"] <= 16 * 1024 * 1024
    ):
        raise AlcorLangError("hosted max_output_bytes is invalid")
    if values["authority_capsule"] is not None and type(values["authority_capsule"]) is not bytes:
        raise AlcorLangError("authority_capsule must be opaque bytes")
    if type(values["authority_capsule"]) is bytes and len(values["authority_capsule"]) > 64 * 1024:
        raise AlcorLangError("authority_capsule exceeds 64 KiB")
    for callback, name in (
        (values["authority_verifier"], "authority_verifier"),
        (values["gate_adapter"], "gate_adapter"),
        (values["receipt_sink"], "receipt_sink"),
    ):
        if callback is not None and not callable(callback):
            raise AlcorLangError(f"{name} must be callable")
    return values


def snapshot_hosted_context(context: object) -> ExecutionContext:
    """Validate once, then detach the run from caller-owned mutable identity."""
    values = _validate_hosted_context(context)
    return ExecutionContext(
        "hosted",
        gate_adapter=values["gate_adapter"],
        lifecycle=values["lifecycle"],
        receipt_sink=values["receipt_sink"],
        correlation_id=values["correlation_id"],
        idempotency_sha256=values["idempotency_sha256"],
        source_revision=values["source_revision"],
        adapter_revision=values["adapter_revision"],
        authority_capsule=values["authority_capsule"],
        authority_verifier=values["authority_verifier"],
        max_fuel=values["max_fuel"],
        timeout_ms=values["timeout_ms"],
        max_output_bytes=values["max_output_bytes"],
        _factory_token=_FACTORY_TOKEN,
    )


class RunBinding:
    """What a hosted run is allowed to do, bound to the exact run.

    Records the SHA-256 of the source, compiled Core, vocabulary, runtime build, input and effect
    scope, plus the authority decision.  It is immutable once built.
    """

    __slots__ = (
        "source_sha256",
        "core_sha256",
        "vocabulary_sha256",
        "runtime_sha256",
        "input_sha256",
        "effect_scope_sha256",
        "authority",
        "authority_verification_sha256",
        "challenge_sha256",
        "granted",
        "valid_until_utc",
        "reason",
        "_sealed",
    )

    def __init__(
        self,
        source_sha256: str,
        core_sha256: str,
        vocabulary_sha256: str,
        runtime_sha256: str,
        input_sha256: str,
        effect_scope_sha256: str,
        authority: str = "none",
        authority_verification_sha256: str | None = None,
        challenge_sha256: str | None = None,
        valid_until_utc: str | None = None,
        granted: bool = False,
        reason: str = "runtime_authority_missing",
    ) -> None:
        object.__setattr__(self, "source_sha256", source_sha256)
        object.__setattr__(self, "core_sha256", core_sha256)
        object.__setattr__(self, "vocabulary_sha256", vocabulary_sha256)
        object.__setattr__(self, "runtime_sha256", runtime_sha256)
        object.__setattr__(self, "input_sha256", input_sha256)
        object.__setattr__(self, "effect_scope_sha256", effect_scope_sha256)
        object.__setattr__(self, "authority", authority)
        object.__setattr__(self, "authority_verification_sha256", authority_verification_sha256)
        object.__setattr__(self, "challenge_sha256", challenge_sha256)
        object.__setattr__(self, "valid_until_utc", valid_until_utc)
        object.__setattr__(self, "granted", bool(granted))
        object.__setattr__(self, "reason", reason)
        object.__setattr__(self, "_sealed", True)

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("run binding is immutable")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("run binding is immutable")


def binding_projection(binding: RunBinding, context: ExecutionContext) -> dict[str, Any]:
    """Project a binding and its context into the record every effect request carries.

    The result includes its own ``binding_sha256``, so a gate can check that the request it
    received belongs to the run it was granted for.
    """
    projection = {
        "schema": "alcor.runtime.binding.v1",
        "correlation_id": context.correlation_id,
        "idempotency_sha256": context.idempotency_sha256,
        "source_sha256": binding.source_sha256,
        "core_sha256": binding.core_sha256,
        "vocabulary_sha256": binding.vocabulary_sha256,
        "runtime_sha256": binding.runtime_sha256,
        "input_sha256": binding.input_sha256,
        "source_revision": context.source_revision,
        "adapter_revision": context.adapter_revision,
        "effect_scope_sha256": binding.effect_scope_sha256,
        "authority": binding.authority,
        "authority_verification_sha256": binding.authority_verification_sha256,
        "authority_valid_until_utc": binding.valid_until_utc,
        "max_fuel": context.max_fuel,
        "timeout_ms": context.timeout_ms,
        "max_output_bytes": context.max_output_bytes,
    }
    projection["binding_sha256"] = digest_record(projection, "binding_sha256")
    return projection
