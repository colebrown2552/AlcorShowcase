"""Hosted execution: verify authority for the exact run, then execute and return a receipt.

``run_hosted`` refuses to run a ``complete``-profile or effectful program unless the host's
verifier binds an opaque authority capsule to a challenge that names the exact source, compiled
Core, vocabulary, runtime build, input and effect scope.  ``authority=conformance`` in the
source never satisfies that check.
"""

from __future__ import annotations

import time
from typing import Any

from .context import (
    CallbackCapacityExhausted,
    DeadlineExpired,
    ExecutionContext,
    RunBinding,
    binding_projection,
    call_before_deadline,
    parse_future_utc,
    snapshot_hosted_context,
)
from .core import Core, compile_core
from .errors import AlcorLangError
from .identity import implementation_sha256
from .machine import Machine
from .receipts import (
    canonical_json_bytes,
    closed_object,
    digest_record,
    normal_json,
    require_hex64,
    require_safe_id,
    sha256_hex,
)
from .vocabulary import semantic_vocabulary_snapshot

EXECUTION_RESULT_SCHEMA = "alcor.execution.result.v1"
AUTHORITY_CHALLENGE_SCHEMA = "alcor.runtime.authority.challenge.v1"
AUTHORITY_DECISION_SCHEMA = "alcor.runtime.authority.decision.v1"

# The authority classes a verifier may grant, weakest first.  Effects need ``operator_gated``;
# a ``complete`` program needs more than ``read_only`` or ``safety_signal``.
_AUTHORITY_CLASSES = frozenset(
    (
        "read_only",
        "data_only",
        "proposal_only",
        "operator_text_only",
        "operator_gated",
        "safety_signal",
    )
)

# Pin the build identity once, at import.  A later file edit must not let already-loaded code
# claim the digest of bytes it is not executing.  If the files cannot be read the identity is
# unavailable and authority is refused (fail closed) rather than granted against a made-up
# digest.
try:
    _RUNTIME_IMPLEMENTATION_SHA256 = implementation_sha256()
    _RUNTIME_IMPLEMENTATION_VERIFIED = True
except OSError:
    _RUNTIME_IMPLEMENTATION_SHA256 = sha256_hex(b"alcorlang-runtime-unreadable")
    _RUNTIME_IMPLEMENTATION_VERIFIED = False


def core_runtime_snapshot(core: Core) -> dict[str, Any]:
    """Describe a compiled program as plain JSON, for hashing into the run binding."""
    return {
        "schema": "alcor.core.runtime.v1",
        "profile": core.profile,
        "source_authority": core.authority,
        "fuel": core.fuel,
        "blocks": [
            {
                "name": block.name,
                "registers": list(block.regs),
                "instructions": [normal_json(ins) for ins in block.code],
            }
            for block in core.ordered_blocks()
        ],
    }


def effect_descriptors(core: Core) -> list[Any]:
    """List the gate descriptors of every EFFECT instruction, in block order.

    This list is the *effect scope* of a run: what a verifier is asked to authorise.
    """
    return [
        normal_json(ins[1])
        for block in core.ordered_blocks()
        for ins in block.code
        if ins[0] == "EFFECT"
    ]


def verify_run_binding(
    src: str,
    input_text: str,
    core: Core,
    context: ExecutionContext,
    deadline: float | None = None,
) -> RunBinding:
    """Decide whether this exact run may execute, by asking the host's verifier.

    A pure ``default``-profile program needs no authority.  Otherwise a *challenge* naming the
    source, Core, vocabulary, runtime build, input, effect scope and limits is built, and the
    verifier must return a decision bound to the same challenge, capsule and scope.  Every
    failure mode (no verifier, timeout, wrong shape, mismatched digest, expired) yields a
    binding with ``granted=False`` and a reason code; nothing here raises on a bad decision.

    Args:
        src: The program text.
        input_text: The input tape.
        core: The compiled program.
        context: A hosted context.
        deadline: Monotonic deadline for the verifier callback.

    Returns:
        The run binding, granted or not.
    """
    source_sha = sha256_hex(src.encode("utf-8"))
    core_sha = sha256_hex(canonical_json_bytes(core_runtime_snapshot(core)))
    vocabulary_sha = sha256_hex(canonical_json_bytes(semantic_vocabulary_snapshot()))
    runtime_sha = _RUNTIME_IMPLEMENTATION_SHA256
    input_sha = sha256_hex(input_text.encode("utf-8"))
    descriptors = effect_descriptors(core)
    effect_scope_sha = sha256_hex(canonical_json_bytes(descriptors))
    needs_authority = core.profile == "complete" or bool(descriptors)
    if not needs_authority:
        return RunBinding(
            source_sha,
            core_sha,
            vocabulary_sha,
            runtime_sha,
            input_sha,
            effect_scope_sha,
            granted=True,
            reason="pure_default",
        )
    if not _RUNTIME_IMPLEMENTATION_VERIFIED:
        return RunBinding(
            source_sha,
            core_sha,
            vocabulary_sha,
            runtime_sha,
            input_sha,
            effect_scope_sha,
            reason="runtime_identity_unavailable",
        )
    challenge = {
        "schema": AUTHORITY_CHALLENGE_SCHEMA,
        "correlation_id": context.correlation_id,
        "idempotency_sha256": context.idempotency_sha256,
        "source_sha256": source_sha,
        "core_sha256": core_sha,
        "vocabulary_sha256": vocabulary_sha,
        "runtime_sha256": runtime_sha,
        "input_sha256": input_sha,
        "source_revision": context.source_revision,
        "adapter_revision": context.adapter_revision,
        "effect_scope_sha256": effect_scope_sha,
        "profile": core.profile,
        "has_effects": bool(descriptors),
        "max_fuel": context.max_fuel,
        "timeout_ms": context.timeout_ms,
        "max_output_bytes": context.max_output_bytes,
    }
    challenge_sha = sha256_hex(canonical_json_bytes(challenge))
    verifier = context.authority_verifier
    capsule = context.authority_capsule
    if not callable(verifier) or capsule is None:
        return RunBinding(
            source_sha,
            core_sha,
            vocabulary_sha,
            runtime_sha,
            input_sha,
            effect_scope_sha,
            challenge_sha256=challenge_sha,
        )
    try:
        if deadline is None:
            decision = verifier(dict(challenge), capsule)
        else:
            decision = call_before_deadline(verifier, (dict(challenge), capsule), deadline)
    except CallbackCapacityExhausted:
        return RunBinding(
            source_sha,
            core_sha,
            vocabulary_sha,
            runtime_sha,
            input_sha,
            effect_scope_sha,
            challenge_sha256=challenge_sha,
            reason="runtime_callback_capacity_exhausted",
        )
    except DeadlineExpired:
        return RunBinding(
            source_sha,
            core_sha,
            vocabulary_sha,
            runtime_sha,
            input_sha,
            effect_scope_sha,
            challenge_sha256=challenge_sha,
            reason="runtime_timeout",
        )
    except Exception:
        return RunBinding(
            source_sha,
            core_sha,
            vocabulary_sha,
            runtime_sha,
            input_sha,
            effect_scope_sha,
            challenge_sha256=challenge_sha,
            reason="runtime_authority_verifier_error",
        )
    required = frozenset(
        (
            "schema",
            "granted",
            "authority",
            "challenge_sha256",
            "capsule_sha256",
            "scope_sha256",
            "verifier_id",
            "valid_until_utc",
        )
    )
    if not closed_object(decision, required):
        return RunBinding(
            source_sha,
            core_sha,
            vocabulary_sha,
            runtime_sha,
            input_sha,
            effect_scope_sha,
            challenge_sha256=challenge_sha,
            reason="runtime_authority_decision_invalid",
        )
    try:
        if type(decision["schema"]) is not str or decision["schema"] != AUTHORITY_DECISION_SCHEMA:
            raise AlcorLangError("wrong authority decision schema")
        if decision["granted"] is not True:
            raise AlcorLangError("runtime authority was not granted")
        authority = decision["authority"]
        if type(authority) is not str or authority not in _AUTHORITY_CLASSES:
            raise AlcorLangError("runtime authority class is insufficient")
        if descriptors and authority != "operator_gated":
            raise AlcorLangError("effects require operator_gated runtime authority")
        if core.profile == "complete" and authority in ("read_only", "safety_signal"):
            raise AlcorLangError("complete profile requires execution authority")
        require_hex64(decision["challenge_sha256"], "challenge_sha256")
        require_hex64(decision["capsule_sha256"], "capsule_sha256")
        require_hex64(decision["scope_sha256"], "scope_sha256")
        if decision["challenge_sha256"] != challenge_sha:
            raise AlcorLangError("authority challenge binding mismatch")
        if decision["capsule_sha256"] != sha256_hex(capsule):
            raise AlcorLangError("authority capsule binding mismatch")
        if decision["scope_sha256"] != effect_scope_sha:
            raise AlcorLangError("authority scope binding mismatch")
        require_safe_id(decision["verifier_id"], "verifier_id")
        parse_future_utc(decision["valid_until_utc"])
    except AlcorLangError:
        return RunBinding(
            source_sha,
            core_sha,
            vocabulary_sha,
            runtime_sha,
            input_sha,
            effect_scope_sha,
            challenge_sha256=challenge_sha,
            reason="runtime_authority_decision_rejected",
        )
    verification_sha = sha256_hex(canonical_json_bytes(decision))
    return RunBinding(
        source_sha,
        core_sha,
        vocabulary_sha,
        runtime_sha,
        input_sha,
        effect_scope_sha,
        authority=authority,
        authority_verification_sha256=verification_sha,
        challenge_sha256=challenge_sha,
        valid_until_utc=decision["valid_until_utc"],
        granted=True,
        reason="verified",
    )


def run_hosted(
    src: str,
    input_text: str = "",
    base_dir: str | None = None,
    context: ExecutionContext | None = None,
    cells: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Execute a program under host-verified authority and return one typed run receipt.

    This door never accepts ``authority=conformance`` as machine authority.  A
    complete-profile or effectful program runs only when the host verifier binds an opaque
    authority capsule to the exact source, Core, vocabulary, runtime build, input and scope.
    The host's ``max_fuel`` always caps the program's own ``fuel``, including ``fuel=0``.

    Args:
        src: v1, v2 or v3 source (at most 1 MiB).
        input_text: Text whose lines feed READ (at most 16 MiB).
        base_dir: The include root.
        context: A context built by ``ExecutionContext.hosted``.
        cells: Cells bound by name in the entry frame.

    Returns:
        A self-hashed ``alcor.execution.result.v1`` record: state, reason code, the digests of
        everything the run was bound to, the tape, and every effect receipt.

    Raises:
        AlcorLangError: If the context is not a valid hosted context, an input is oversized
            or not text, or the source is rejected at compile time.
    """
    context = snapshot_hosted_context(context)
    deadline = time.monotonic() + context.timeout_ms / 1000.0
    if type(src) is not str or type(input_text) is not str:
        raise AlcorLangError("hosted source and input must be text")
    try:
        source_size = len(src.encode("utf-8"))
        input_size = len(input_text.encode("utf-8"))
    except UnicodeEncodeError:
        raise AlcorLangError("hosted source and input must be strict UTF-8") from None
    if source_size > 1024 * 1024:
        raise AlcorLangError("hosted source exceeds 1 MiB")
    if input_size > 16 * 1024 * 1024:
        raise AlcorLangError("hosted input exceeds 16 MiB")
    core = compile_core(src, base_dir)
    binding = verify_run_binding(src, input_text, core, context, deadline=deadline)
    # The binding above names the program's declared fuel; the cap below is what actually
    # runs.  A copy, because the compiled Core is cached and shared between runs.
    capped = context.max_fuel if core.fuel == 0 else min(core.fuel, context.max_fuel)
    core = core.with_fuel(capped)
    machine = Machine(
        core, input_text, context=context, binding=binding, cells=cells, deadline=deadline
    )
    tape = machine.execute()
    trap = machine.trap_code
    if machine.runtime_stop is not None:
        state, reason = machine.runtime_stop
    elif trap:
        state, reason = "failed", "trap_" + trap
    else:
        state, reason = "complete", "completed"
    result = {
        "schema": EXECUTION_RESULT_SCHEMA,
        "state": state,
        "reason_code": reason,
        "correlation_id": context.correlation_id,
        "idempotency_sha256": context.idempotency_sha256,
        "source_sha256": binding.source_sha256,
        "core_sha256": binding.core_sha256,
        "vocabulary_sha256": binding.vocabulary_sha256,
        "runtime_sha256": binding.runtime_sha256,
        "input_sha256": binding.input_sha256,
        "effect_scope_sha256": binding.effect_scope_sha256,
        "run_binding_sha256": binding_projection(binding, context)["binding_sha256"],
        "source_revision": context.source_revision,
        "adapter_revision": context.adapter_revision,
        "profile": core.profile,
        "steps": machine.steps,
        "fuel": core.fuel,
        "max_fuel": context.max_fuel,
        "timeout_ms": context.timeout_ms,
        "max_output_bytes": context.max_output_bytes,
        "tape": tape,
        "tape_sha256": sha256_hex(tape.encode("utf-8")),
        "authority": binding.authority,
        "authority_verified": bool(binding.authority_verification_sha256),
        "authority_verification_sha256": binding.authority_verification_sha256,
        "authority_challenge_sha256": binding.challenge_sha256,
        "authority_valid_until_utc": binding.valid_until_utc,
        "effect_authority": bool(binding.authority_verification_sha256 and machine.effect_results),
        "effects": list(machine.effect_results),
        "effect_replays": list(machine.effect_replays),
        "no_auto_replay": True,
    }
    result["receipt_sha256"] = digest_record(result, "receipt_sha256")
    return result
