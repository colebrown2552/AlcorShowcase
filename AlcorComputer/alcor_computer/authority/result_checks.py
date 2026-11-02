"""Closed-shape validation for completed read-lane results and for outer chains.

A result is only signed (and only trusted when verified) if each receipt has exactly the fields
its phase defines, with the expected values, and the observations agree with the receipts that
describe them. Outer chains, the records handed to the computer-use mediator, are held to an
equally strict shape.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from ..contracts import sha256_hex
from .contract import (
    _OPAQUE_RE,
    _PREFIX_RE,
    _SHA256_RE,
    BASE_RECEIPT_SCHEMA,
    CONTRACT_SHA256_PREFIX,
    HASH_PREFIX_LENGTH,
    READ_CHAIN_PHASES,
    READLANE_SCHEMA,
    AuthorityError,
)
from .values import BoundedObservation, ReadLaneResult, ReadScopeToken

_COMMON_RECEIPT_FIELDS = frozenset(
    (
        "schema",
        "extends",
        "phase",
        "ok",
        "reason_code",
        "live_state_touched",
        "contract_sha256_prefix",
    )
)
_RECEIPT_EXTRA_FIELDS = {
    "prepared": frozenset(
        ("scope_authenticated", "path_glob_count", "verb_count", "operator_turns")
    ),
    "search": frozenset(
        ("result_count", "content_sha256_prefix", "body_truncated_to_cap", "body_was_truncated")
    ),
    "read": frozenset(
        ("result_count", "content_sha256_prefix", "body_truncated_to_cap", "body_was_truncated")
    ),
    "completed": frozenset(
        ("typed_code_completed", "operator_completed_step", "receipt_count", "chain_sha256_prefix")
    ),
}
_COMPUTER_CHAIN_FIELDS = frozenset(
    (
        "schema",
        "arm",
        "scope_id",
        "scope_contract_sha256_prefix",
        "issuer_receipt_sha256",
        "observation_receipt_sha256",
        "issued_at_unix_ms",
        "expires_at_unix_ms",
        "nonce",
        "frame_sha256",
        "projection",
    )
)
_PROJECTION_FIELDS = frozenset(
    ("target_ref", "candidate_count", "x", "y", "screen_width", "screen_height")
)


def _closed_keys(value: Any, expected: frozenset[str], reason: str) -> Mapping[str, Any]:
    """Require a dict whose key set equals ``expected``, failing with ``reason``."""
    if not isinstance(value, dict) or frozenset(value) != expected:
        raise AuthorityError(reason)
    return value


def _exact_int(value: Any, minimum: int = 0) -> int:
    """Require a real ``int`` (not ``bool``) of at least ``minimum``."""
    if type(value) is not int or value < minimum:
        raise AuthorityError("readlane_result_invalid")
    return value


def validate_result_components(
    token: ReadScopeToken,
    receipts: Sequence[Mapping[str, Any]],
    observations: Sequence[BoundedObservation],
) -> tuple[tuple[Mapping[str, Any], ...], tuple[BoundedObservation, ...]]:
    """Check that four receipts and two observations form one coherent, completed chain.

    The phase list is walked in protocol order, so a receipt in the wrong position fails its
    field check. Counts and hash prefixes in the search and read receipts must equal what the
    observations actually contain, and the final receipt must carry the hash of the first three.

    Args:
        token: The validated scope.
        receipts: Exactly four receipts: prepared, search, read, completed.
        observations: Exactly two observations: search first, then read.

    Returns:
        The receipts (copied to plain dicts) and the observations as tuples.

    Raises:
        AuthorityError: ``readlane_result_invalid`` on any deviation.
    """
    try:
        raw_receipts = tuple(receipts)
        observation_tuple = tuple(observations)
    except Exception as exc:
        raise AuthorityError("readlane_result_invalid") from exc
    if len(raw_receipts) != len(READ_CHAIN_PHASES):
        raise AuthorityError("readlane_result_invalid")
    normalized_receipts = []
    for phase, item in zip(READ_CHAIN_PHASES, raw_receipts, strict=True):
        expected_fields = _COMMON_RECEIPT_FIELDS | _RECEIPT_EXTRA_FIELDS[phase]
        receipt = dict(_closed_keys(item, expected_fields, "readlane_result_invalid"))
        normalized_receipts.append(receipt)
        if (
            receipt["schema"] != READLANE_SCHEMA
            or receipt["extends"] != BASE_RECEIPT_SCHEMA
            or receipt["phase"] != phase
            or receipt["ok"] is not True
            or receipt["live_state_touched"] is not False
            or receipt["contract_sha256_prefix"] != CONTRACT_SHA256_PREFIX
            or not isinstance(receipt["reason_code"], str)
        ):
            raise AuthorityError("readlane_result_invalid")
    receipt_tuple = tuple(normalized_receipts)
    prepared, search, read, completed = receipt_tuple
    if (
        prepared["reason_code"] != "prepared"
        or prepared["scope_authenticated"] is not True
        or _exact_int(prepared["path_glob_count"], 1) != len(token.path_globs)
        or _exact_int(prepared["verb_count"], 1) != len(token.verbs)
        or type(prepared["operator_turns"]) is not int
        or prepared["operator_turns"] != 1
    ):
        raise AuthorityError("readlane_result_invalid")
    if len(observation_tuple) != 2:
        raise AuthorityError("readlane_result_invalid")
    for phase, receipt, observation in (
        ("search", search, observation_tuple[0]),
        ("read", read, observation_tuple[1]),
    ):
        if not isinstance(observation, BoundedObservation):
            raise AuthorityError("readlane_result_invalid")
        if (
            receipt["reason_code"] != "validated_observation"
            or type(receipt["result_count"]) is not int
            or receipt["result_count"] < (0 if phase == "search" else 1)
            or (phase == "read" and receipt["result_count"] != 1)
            or receipt["result_count"] > token.max_results
            or type(observation.result_count) is not int
            or receipt["result_count"] != observation.result_count
            or receipt["content_sha256_prefix"] != observation.content_sha256_prefix
            or not isinstance(receipt["content_sha256_prefix"], str)
            or _PREFIX_RE.fullmatch(receipt["content_sha256_prefix"]) is None
            or receipt["body_truncated_to_cap"] is not True
            or type(receipt["body_was_truncated"]) is not bool
            or receipt["body_was_truncated"] is not observation.body_was_truncated
            or not isinstance(observation.body_truncated_to_cap, str)
            or len(observation.body_truncated_to_cap.encode("utf-8")) > token.max_bytes
        ):
            raise AuthorityError("readlane_result_invalid")
    expected_chain_prefix = sha256_hex(list(receipt_tuple[:3]))[:HASH_PREFIX_LENGTH]
    if (
        completed["reason_code"] != "typed_code_completed"
        or completed["typed_code_completed"] is not True
        or completed["operator_completed_step"] is not False
        or type(completed["receipt_count"]) is not int
        or completed["receipt_count"] != len(READ_CHAIN_PHASES)
        or completed["chain_sha256_prefix"] != expected_chain_prefix
        or _PREFIX_RE.fullmatch(completed["chain_sha256_prefix"]) is None
    ):
        raise AuthorityError("readlane_result_invalid")
    return receipt_tuple, observation_tuple


def validate_computer_chain(result: ReadLaneResult, chain: Mapping[str, Any]) -> str:
    """Check an outer read-chain against the result it claims to describe.

    The chain must have exactly the documented fields, point at this result's scope and receipt
    hashes, carry a sane validity window and a nonce, and project to exactly one on-screen
    candidate (``candidate_count == 1``, point inside the screen).

    Args:
        result: The authenticated lane result.
        chain: The outer chain dict.

    Returns:
        The chain's SHA-256 digest.

    Raises:
        AuthorityError: ``readlane_chain_mismatch`` on any deviation.
    """
    outer = _closed_keys(chain, _COMPUTER_CHAIN_FIELDS, "readlane_chain_mismatch")
    projection = _closed_keys(outer["projection"], _PROJECTION_FIELDS, "readlane_chain_mismatch")
    if (
        outer["schema"] != "alcor.computer.union.v1"
        or outer["arm"] != "read-chain"
        or outer["scope_id"] != result.token.scope_id
        or outer["scope_contract_sha256_prefix"] != CONTRACT_SHA256_PREFIX
        or outer["issuer_receipt_sha256"] != sha256_hex(result.receipts[0])
        or outer["observation_receipt_sha256"] != sha256_hex(list(result.receipts))
        or _SHA256_RE.fullmatch(outer["issuer_receipt_sha256"]) is None
        or _SHA256_RE.fullmatch(outer["observation_receipt_sha256"]) is None
        or type(outer["issued_at_unix_ms"]) is not int
        or type(outer["expires_at_unix_ms"]) is not int
        or outer["issued_at_unix_ms"] < 0
        or outer["expires_at_unix_ms"] <= outer["issued_at_unix_ms"]
        or not isinstance(outer["nonce"], str)
        or len(outer["nonce"]) < 16
        or _OPAQUE_RE.fullmatch(outer["nonce"]) is None
        or not isinstance(outer["frame_sha256"], str)
        or _SHA256_RE.fullmatch(outer["frame_sha256"]) is None
        or not isinstance(projection["target_ref"], str)
        or _OPAQUE_RE.fullmatch(projection["target_ref"]) is None
        or any(type(projection[field]) is not int for field in _PROJECTION_FIELDS - {"target_ref"})
        or projection["candidate_count"] != 1
        or projection["x"] < 0
        or projection["y"] < 0
        or projection["screen_width"] <= 0
        or projection["screen_height"] <= 0
        or projection["x"] >= projection["screen_width"]
        or projection["y"] >= projection["screen_height"]
    ):
        raise AuthorityError("readlane_chain_mismatch")
    return sha256_hex(outer)
