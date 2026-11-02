"""Canonical JSON, digests and the effect request/result records (``alcor.effect.*.v1``).

An embedded v1 statement never runs inside the language.  It becomes an EFFECT instruction whose
meaning is the host gate's answer, and every attempt yields a self-hashed record so a refusal
or an outcome can be audited later.  The records are closed schemas: an unknown key, a wrong
type or a digest that does not match fails closed.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any

from .errors import AlcorLangError

# `run()` is the byte-for-byte conformance door fixed by the v2 corpus and has no machine
# authority.  `run_hosted()` is the production-shaped door: authority is produced by a verifier,
# is immutable for the run, and is never accepted from PROGRAM properties.  The durable store
# behind it is the host's; this module deliberately owns no ledger of its own.

EFFECT_REQUEST_SCHEMA = "alcor.effect.request.v1"
EFFECT_RESULT_SCHEMA = "alcor.effect.result.v1"

_HEX64_RE = re.compile(r"\A[0-9a-f]{64}\Z")
_SAFE_ID_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}\Z")
_TERMINAL_EFFECT_STATES = frozenset(("complete", "failed", "unknown", "refused"))


def canonical_json_bytes(value: Any) -> bytes:
    """Serialise a value to the exact bytes that are hashed at every boundary.

    Keys are sorted, separators are compact, non-ASCII is kept as UTF-8 and NaN/Infinity are
    refused, so two hosts that agree on a value agree on its digest.

    Args:
        value: Any JSON-serialisable value.

    Returns:
        The canonical UTF-8 bytes.

    Raises:
        AlcorLangError: If the value is not serialisable as strict JSON.
    """
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as exc:
        raise AlcorLangError(f"runtime contract is not canonical JSON: {exc}") from None


def _strict_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    # `json.loads` keeps the last duplicate key silently; a receipt with two values for one key
    # would then be read differently by two parsers, so duplicates are refused outright.
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f"duplicate JSON key {key!r}")
        obj[key] = value
    return obj


def closed_object(value: object, keys: frozenset[str]) -> bool:
    """Return whether ``value`` is a plain dict whose keys are exactly ``keys`` (all text)."""
    return (
        type(value) is dict and all(type(key) is str for key in value) and frozenset(value) == keys
    )


def sha256_hex(value: bytes) -> str:
    """Return the lowercase hex SHA-256 of ``value``."""
    return hashlib.sha256(value).hexdigest()


def digest_record(value: dict[str, Any], digest_key: str) -> str:
    """Hash a record without its own digest field.

    Args:
        value: The record.
        digest_key: The field that holds the record's digest; it is excluded from the hash.

    Returns:
        The hex digest of the canonical JSON of the remaining fields.
    """
    body = dict(value)
    body.pop(digest_key, None)
    return sha256_hex(canonical_json_bytes(body))


def require_hex64(value: object, name: str) -> str:
    """Return ``value`` if it is a lowercase 64-digit hex digest, else raise.

    Raises:
        AlcorLangError: If it is anything else; the message names ``name``.
    """
    if type(value) is not str or not _HEX64_RE.match(value):
        raise AlcorLangError(f"{name} must be a lowercase sha256 digest")
    return value


def require_safe_id(value: object, name: str) -> str:
    """Return ``value`` if it is a bounded identifier (letters, digits, ``._:@/-``), else raise.

    Raises:
        AlcorLangError: If it is anything else; the message names ``name``.
    """
    if type(value) is not str or not _SAFE_ID_RE.match(value):
        raise AlcorLangError(f"{name} is not a bounded runtime identifier")
    return value


def normal_json(value: Any) -> Any:
    """Normalise a value to plain JSON types with sorted object keys.

    Tuples become lists.  Only ``dict``, ``list``, ``tuple``, ``str``, ``int``, ``bool`` and
    ``None`` are accepted, so nothing exotic can reach a digest.

    Raises:
        AlcorLangError: On any other type, or on a non-text object key.
    """
    if type(value) is dict:
        if any(type(key) is not str for key in value):
            raise AlcorLangError("canonical runtime object keys must be text")
        return {key: normal_json(value[key]) for key in sorted(value)}
    if type(value) in (list, tuple):
        return [normal_json(item) for item in value]
    if type(value) in (str, int, bool) or value is None:
        return value
    raise AlcorLangError("ALCORCORE contains non-canonical runtime data")


def effect_result(
    request: dict[str, Any],
    outcome: str,
    reason_code: str,
    effect_started: bool = False,
    effect_committed: bool = False,
    postcondition_verified: bool = False,
    result: Any = None,
    attempted: bool = True,
    result_sha256: str | None = None,
) -> dict[str, Any]:
    """Build the one closed result record a gate may answer with.

    The state invariants are enforced here, so a record that claims more than it can (for
    example ``complete`` without commit evidence, or ``refused`` with a started effect) cannot
    be constructed at all.

    Args:
        request: A request built by the runtime (checked against the closed schema).
        outcome: ``complete``, ``failed``, ``unknown`` or ``refused``.
        reason_code: A short bounded identifier explaining the outcome.
        effect_started: Whether the effect began.
        effect_committed: Whether the effect took lasting effect.
        postcondition_verified: Whether the host verified the postcondition afterwards.
        result: Optional result data; only its digest is stored.
        attempted: Whether the gate was actually called.
        result_sha256: A precomputed digest to use instead of ``result``.

    Returns:
        The self-hashed ``alcor.effect.result.v1`` record.

    Raises:
        AlcorLangError: If the arguments contradict each other or the request is malformed.
    """
    _validate_effect_request(request)
    if type(outcome) is not str or outcome not in _TERMINAL_EFFECT_STATES:
        raise AlcorLangError(f"unknown effect outcome {outcome!r}")
    require_safe_id(reason_code, "reason_code")
    for value, name in (
        (attempted, "attempted"),
        (effect_started, "effect_started"),
        (effect_committed, "effect_committed"),
        (postcondition_verified, "postcondition_verified"),
    ):
        if type(value) is not bool:
            raise AlcorLangError(f"{name} must be boolean")
    if (effect_started or effect_committed) and not attempted:
        raise AlcorLangError("an unattempted effect cannot start or commit")
    if effect_committed and not effect_started:
        raise AlcorLangError("a committed effect must have started")
    if outcome == "complete" and not (
        effect_started and effect_committed and postcondition_verified
    ):
        raise AlcorLangError("complete effect lacks commit/postcondition evidence")
    if outcome == "failed" and (not attempted or not postcondition_verified):
        raise AlcorLangError("failed effect must be attempted and postcondition-verified")
    if outcome == "unknown" and not attempted:
        raise AlcorLangError("unknown effect must cross an attempted boundary")
    if outcome == "refused" and (effect_started or effect_committed):
        raise AlcorLangError("refused effect cannot claim a started effect")
    if result is not None and result_sha256 is not None:
        raise AlcorLangError("effect result accepts raw data or a digest, not both")
    if result_sha256 is not None:
        require_hex64(result_sha256, "result_sha256")
    try:
        result_digest = (
            result_sha256
            if result_sha256 is not None
            else (None if result is None else sha256_hex(canonical_json_bytes(normal_json(result))))
        )
    except RecursionError:
        raise AlcorLangError("effect result exceeds canonical nesting bounds") from None
    body = {
        "schema": EFFECT_RESULT_SCHEMA,
        "request_id": request["request_id"],
        "request_sha256": request["request_sha256"],
        "sequence": request["sequence"],
        "outcome": outcome,
        "reason_code": reason_code,
        "attempted": attempted,
        "effect_started": effect_started,
        "effect_committed": effect_committed,
        "postcondition_verified": postcondition_verified,
        "result_sha256": result_digest,
        "replay": "original",
    }
    body["receipt_sha256"] = digest_record(body, "receipt_sha256")
    return body


def _validate_effect_request(request: object) -> None:
    keys = frozenset(
        (
            "schema",
            "request_id",
            "correlation_id",
            "sequence",
            "idempotency_sha256",
            "run_binding_sha256",
            "descriptor",
            "resolved",
            "request_sha256",
        )
    )
    if not closed_object(request, keys):
        raise AlcorLangError("effect request does not match the closed v1 schema")
    if type(request["schema"]) is not str or request["schema"] != EFFECT_REQUEST_SCHEMA:
        raise AlcorLangError("wrong effect request schema")
    require_safe_id(request["request_id"], "request_id")
    require_safe_id(request["correlation_id"], "correlation_id")
    if type(request["sequence"]) is not int or request["sequence"] < 0:
        raise AlcorLangError("effect sequence must be a non-negative integer")
    require_hex64(request["idempotency_sha256"], "idempotency_sha256")
    require_hex64(request["run_binding_sha256"], "run_binding_sha256")
    require_hex64(request["request_sha256"], "request_sha256")
    descriptor = request["descriptor"]
    descriptor_keys = frozenset(("verb", "object", "value_raw", "props_raw", "tail"))
    if not closed_object(descriptor, descriptor_keys):
        raise AlcorLangError("effect descriptor does not match the closed schema")
    if type(descriptor["verb"]) is not str or type(descriptor["object"]) is not str:
        raise AlcorLangError("effect descriptor verb/object must be text")
    if descriptor["value_raw"] is not None and type(descriptor["value_raw"]) is not str:
        raise AlcorLangError("effect descriptor value_raw must be text or null")
    props_raw = descriptor["props_raw"]
    if type(props_raw) is not dict or any(
        type(key) is not str or type(value) is not str for key, value in props_raw.items()
    ):
        raise AlcorLangError("effect descriptor props_raw must be text pairs")
    tail = descriptor["tail"]
    if tail is not None:
        tail_keys = frozenset(("dir", "object", "name"))
        if not closed_object(tail, tail_keys):
            raise AlcorLangError("effect descriptor tail does not match the closed schema")
        if (
            type(tail["dir"]) is not str
            or tail["dir"] not in ("TO", "FROM")
            or type(tail["object"]) is not str
        ):
            raise AlcorLangError("effect descriptor tail is invalid")
        if tail["name"] is not None and type(tail["name"]) is not str:
            raise AlcorLangError("effect descriptor tail name must be text or null")
    resolved = request["resolved"]
    if not closed_object(resolved, frozenset(("value", "props"))):
        raise AlcorLangError("resolved effect does not match the closed schema")
    if resolved["value"] is not None and type(resolved["value"]) is not str:
        raise AlcorLangError("resolved effect value must be text or null")
    if type(resolved["props"]) is not dict or any(
        type(key) is not str or type(value) is not str for key, value in resolved["props"].items()
    ):
        raise AlcorLangError("resolved effect props must be text pairs")
    if request["request_sha256"] != digest_record(request, "request_sha256"):
        raise AlcorLangError("effect request digest mismatch")


def _validate_effect_result(result: object, request: dict[str, Any]) -> dict[str, Any]:
    keys = frozenset(
        (
            "schema",
            "request_id",
            "request_sha256",
            "sequence",
            "outcome",
            "reason_code",
            "attempted",
            "effect_started",
            "effect_committed",
            "postcondition_verified",
            "result_sha256",
            "replay",
            "receipt_sha256",
        )
    )
    if not closed_object(result, keys):
        raise AlcorLangError("effect result does not match the closed v1 schema")
    if type(result["schema"]) is not str or result["schema"] != EFFECT_RESULT_SCHEMA:
        raise AlcorLangError("wrong effect result schema")
    if type(result["sequence"]) is not int:
        raise AlcorLangError("effect result sequence must be an integer")
    if (
        result["request_id"] != request["request_id"]
        or result["request_sha256"] != request["request_sha256"]
        or result["sequence"] != request["sequence"]
    ):
        raise AlcorLangError("effect result request binding mismatch")
    require_hex64(result["receipt_sha256"], "receipt_sha256")
    for key in ("attempted", "effect_started", "effect_committed", "postcondition_verified"):
        if type(result[key]) is not bool:
            raise AlcorLangError(f"effect result {key} must be boolean")
    if type(result["replay"]) is not str or result["replay"] != "original":
        raise AlcorLangError("effect result replay marker is invalid")
    if result["receipt_sha256"] != digest_record(result, "receipt_sha256"):
        raise AlcorLangError("effect result digest mismatch")
    # Rebuild through the public constructor to enforce all state invariants.
    rebuilt = effect_result(
        request,
        result["outcome"],
        result["reason_code"],
        effect_started=result["effect_started"],
        effect_committed=result["effect_committed"],
        postcondition_verified=result["postcondition_verified"],
        result=None,
        attempted=result["attempted"],
        result_sha256=result["result_sha256"],
    )
    if result != rebuilt:
        raise AlcorLangError("effect result invariant mismatch")
    return result


def effect_request_bytes(request: dict[str, Any]) -> bytes:
    """Serialise an effect request to the canonical bytes a gate receives.

    Raises:
        AlcorLangError: If the request is malformed or larger than 1 MiB.
    """
    _validate_effect_request(request)
    raw = canonical_json_bytes(request)
    if len(raw) > 1024 * 1024:
        raise AlcorLangError("effect request exceeds 1 MiB")
    return raw


def effect_result_bytes(result: dict[str, Any], request: dict[str, Any]) -> bytes:
    """Serialise an effect result to the canonical bytes a store keeps.

    Raises:
        AlcorLangError: If the result does not match the request, or is larger than 4096 bytes.
    """
    _validate_effect_result(result, request)
    raw = canonical_json_bytes(result)
    if len(raw) > 4096:
        raise AlcorLangError("effect result exceeds 4096 bytes")
    return raw


def decode_effect_result(raw: object, request: dict[str, Any]) -> dict[str, Any]:
    """Decode and fully validate the bytes a hosted gate returned.

    The bytes must be strict UTF-8 JSON in canonical form (so the digest the gate computed is
    the digest we recompute), with no duplicate keys and no NaN or Infinity, and the record
    must match the request and satisfy every state invariant.

    Args:
        raw: What the gate returned.
        request: The request it is answering.

    Returns:
        The validated result record.

    Raises:
        AlcorLangError: If anything about the bytes or the record is wrong.
    """
    if type(raw) is not bytes:
        raise AlcorLangError("hosted effect gate must return canonical JSON bytes")
    if len(raw) > 4096:
        raise AlcorLangError("effect result exceeds 4096 bytes")
    try:
        text = raw.decode("utf-8")
        result = json.loads(
            text,
            object_pairs_hook=_strict_json_object,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON number {value}")
            ),
        )
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise AlcorLangError("effect result is not strict UTF-8 JSON") from None
    if canonical_json_bytes(result) != raw:
        raise AlcorLangError("effect result bytes are not canonical")
    return _validate_effect_result(result, request)


def _conformance_binding_sha256() -> str:
    return sha256_hex(
        canonical_json_bytes(
            {
                "schema": "alcor.runtime.binding.conformance.v1",
                "mode": "conformance",
            }
        )
    )


def _conformance_effect_request(
    seq: int, descriptor: dict[str, Any], resolved: dict[str, Any]
) -> dict[str, Any]:
    identity = {
        "correlation_id": "conformance",
        "sequence": seq,
        "idempotency_sha256": sha256_hex(b"conformance"),
    }
    request = {
        "schema": EFFECT_REQUEST_SCHEMA,
        "request_id": "effect-" + sha256_hex(canonical_json_bytes(identity))[:40],
        "correlation_id": "conformance",
        "sequence": seq,
        "idempotency_sha256": identity["idempotency_sha256"],
        "run_binding_sha256": _conformance_binding_sha256(),
        "descriptor": normal_json(descriptor),
        "resolved": normal_json(resolved),
    }
    request["request_sha256"] = digest_record(request, "request_sha256")
    return request


def gate_not_wired(
    seq: int, descriptor: dict[str, Any], resolved: dict[str, Any]
) -> dict[str, Any]:
    """The conformance gate: record a typed refusal and perform nothing.

    Spec section 6.4 defines an effect as the host gate's answer.  With no host wired, the answer
    is a self-hashed ``refused``/``not_wired`` receipt written to ``receipts/effect_<seq>.json`` in
    the current directory.  The request keeps the raw placeholder text and the resolved text in
    separate fields.

    Args:
        seq: The zero-based sequence number of this attempt within the run.
        descriptor: The raw gate descriptor from the EFFECT instruction.
        resolved: The same statement with ``$cell`` placeholders substituted.

    Returns:
        The receipt that was written.
    """
    request = _conformance_effect_request(seq, descriptor, resolved)
    receipt = effect_result(request, "refused", "not_wired", attempted=False)
    directory = os.path.join(os.getcwd(), "receipts")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"effect_{seq}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(receipt, fh, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fh.write("\n")
    return receipt


def confirmed_terminal_effect(existing: object, request: dict[str, Any]) -> dict[str, Any] | None:
    """Return only an exact, internally consistent durable terminal receipt."""
    if type(existing) is bytes:
        try:
            return decode_effect_result(existing, request)
        except AlcorLangError:
            return None
    if type(existing) is not dict:
        return None
    stored_sha = existing.get("request_sha256")
    if type(stored_sha) is not str or stored_sha != request["request_sha256"]:
        return None
    stored_state = existing.get("state")
    if type(stored_state) is not str:
        return None
    state = stored_state.lower()
    if state not in _TERMINAL_EFFECT_STATES:
        return None
    raw = existing.get("result")
    if type(raw) is not bytes:
        return None
    try:
        result = decode_effect_result(raw, request)
    except AlcorLangError:
        return None
    if result["outcome"] != state:
        return None
    return result
