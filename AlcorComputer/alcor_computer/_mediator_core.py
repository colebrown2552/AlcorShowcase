"""Contract core of the mediator: validate and stage one click proposal, never perform it.

Input is two untrusted JSON documents. The *read-chain* says what was observed (it comes from the
authority lane); the *computer bundle* proposes a single left click on the one target that
observation projected. The core checks both against closed shapes, checks that the bundle is
bound to the exact read-chain by hash, asks an injected verifier whether the lane really produced
that chain, and consumes the proposal once so it cannot be replayed.

This module never imports an input library, opens a connection or launches a process. Its
receipts always say ``input_fired: false``: staging hands a sanitised, single-use proposal to
whatever gated broker sits downstream.

This is the bottom of three layers that share a class name: ``_mediator_core`` (this file, the
contract), ``secure_mediator`` (adds the pinned readiness gate and a strict ledger) and
``mediator`` (the public class, which bounds every failure into a receipt).
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from .contracts import (
    COMPUTER_BUNDLE_ARM,
    HASH_PREFIX_LENGTH,
    PLUGIN_SCHEMA,
    READ_CHAIN_ARM,
    RECEIPT_SCHEMA,
    SCHEMA_NAME,
    STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
    UNION_SCHEMA_SHA256_PREFIX,
    canonical_bytes,
    sha256_hex,
)

MAX_JSON_BYTES = 64 * 1024
MAX_SCOPE_WINDOW_MS = 30_000
MAX_CLOCK_SKEW_MS = 5_000
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PREFIX_RE = re.compile(r"^[0-9a-f]{12}$")
_OPAQUE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_NONCE_RE = re.compile(r"^[A-Za-z0-9._:-]{16,128}$")

ReasonCode = str
ReadChainVerifier = Callable[[Mapping[str, Any], str], bool]

READ_CHAIN_FIELDS = frozenset(
    {
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
    }
)
PROJECTION_FIELDS = frozenset(
    {"target_ref", "candidate_count", "x", "y", "screen_width", "screen_height"}
)
BUNDLE_FIELDS = frozenset(
    {
        "schema",
        "arm",
        "scope_id",
        "mediator_contract_sha256_prefix",
        "read_chain_sha256",
        "nonce",
        "action",
    }
)
ACTION_FIELDS = frozenset({"operation", "target_ref", "button"})


class ContractError(ValueError):
    """A fail-closed contract rejection that carries only a sanitised reason code.

    Attributes:
        reason_code: Short snake_case code such as ``stale_scope``.
    """

    def __init__(self, reason_code: ReasonCode) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


class ReplayStoreError(RuntimeError):
    """The replay ledger could not be read or written; the message is a reason code."""


class ReplayStore(Protocol):
    """What the mediator needs from a replay ledger: record a key, report if it was new."""

    def consume(self, value: str) -> bool:
        """Record ``value``. Return True the first time, False if it was already consumed."""
        ...


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("duplicate_key")
        result[key] = value
    return result


def _reject_non_json_constant(_: str) -> None:
    raise ContractError("invalid_json_number")


def parse_json_object(raw: str) -> dict[str, Any]:
    """Parse untrusted JSON into a dict, refusing anything ambiguous.

    Rejects oversize input, duplicate keys (which parsers resolve inconsistently), ``NaN`` and
    ``Infinity``, and any top-level value that is not an object.

    Raises:
        ContractError: ``invalid_json``, ``payload_too_large``, ``duplicate_key``,
            ``invalid_json_number`` or ``invalid_json_shape``.
    """
    if not isinstance(raw, str):
        raise ContractError("invalid_json")
    if len(raw.encode("utf-8")) > MAX_JSON_BYTES:
        raise ContractError("payload_too_large")
    try:
        value = json.loads(
            raw,
            object_pairs_hook=_object_without_duplicate_keys,
            parse_constant=_reject_non_json_constant,
        )
    except ContractError:
        raise
    except (TypeError, ValueError) as exc:
        raise ContractError("invalid_json") from exc
    if not isinstance(value, dict):
        raise ContractError("invalid_json_shape")
    return value


def _closed_object(value: Any, required: frozenset[str]) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ContractError("invalid_shape")
    keys = frozenset(value)
    if keys - required:
        raise ContractError("unknown_field")
    if required - keys:
        raise ContractError("missing_field")
    return value


def _exact_string(value: Any, expected: str) -> None:
    if not isinstance(value, str) or value != expected:
        raise ContractError("invalid_value")


def _opaque_id(value: Any) -> str:
    if not isinstance(value, str) or _OPAQUE_RE.fullmatch(value) is None:
        raise ContractError("invalid_value")
    return value


def _nonce(value: Any) -> str:
    if not isinstance(value, str) or _NONCE_RE.fullmatch(value) is None:
        raise ContractError("invalid_value")
    return value


def _sha256(value: Any) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        raise ContractError("invalid_value")
    return value


def _prefix(value: Any) -> str:
    if not isinstance(value, str) or _PREFIX_RE.fullmatch(value) is None:
        raise ContractError("invalid_value")
    return value


def _integer(value: Any, *, minimum: int = 0, maximum: int | None = None) -> int:
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        raise ContractError("invalid_value")
    return value


@dataclass(frozen=True)
class ValidatedPair:
    """A read-chain and bundle that passed every check.

    Attributes:
        read_chain: The validated read-chain.
        bundle: The validated computer bundle.
        read_chain_sha256: Canonical hash of the read-chain (the bundle's binding).
        replay_key: Hash under which the pair is consumed once.
    """

    read_chain: Mapping[str, Any]
    bundle: Mapping[str, Any]
    read_chain_sha256: str
    replay_key: str


class ComputerUseMediator:
    """Validate and stage a click proposal without exposing any input authority.

    Args:
        read_scope_contract_sha256_prefix: The authority contract prefix a read-chain must carry,
            or None if no contract is available (every validation then fails closed).
        read_chain_verifier: Callable ``(chain, chain_sha256) -> bool`` that says whether the
            authority lane produced this chain, or None.
        replay_ledger: Where consumed proposals are recorded.
        now_ms: Clock in epoch milliseconds; defaults to the wall clock.
    """

    def __init__(
        self,
        *,
        read_scope_contract_sha256_prefix: str | None,
        read_chain_verifier: ReadChainVerifier | None,
        replay_ledger: ReplayStore,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        if read_scope_contract_sha256_prefix is not None:
            _prefix(read_scope_contract_sha256_prefix)
        self.read_scope_contract_sha256_prefix = read_scope_contract_sha256_prefix
        self.read_chain_verifier = read_chain_verifier
        self.replay_ledger = replay_ledger
        self.now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)

    def status(self) -> dict[str, Any]:
        """Describe the plugin, its contracts and its no-input boundary."""
        read_contract_ready = self.read_scope_contract_sha256_prefix is not None
        read_verifier_ready = self.read_chain_verifier is not None
        return {
            "schema": PLUGIN_SCHEMA,
            "plugin": "AlcorComputer",
            "interface": "MCP",
            "schema_arms": [READ_CHAIN_ARM, COMPUTER_BUNDLE_ARM],
            "strict_union": True,
            "closed_shapes": True,
            "contract_sha256_prefix": STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
            "union_schema_sha256_prefix": UNION_SCHEMA_SHA256_PREFIX,
            "read_scope_contract_frozen_green": read_contract_ready and read_verifier_ready,
            "validation_ready": read_contract_ready and read_verifier_ready,
            "operations": ["click"],
            "owner_gated": False,
            "owner_gated_input_reachable": False,
            "actuation_backend_present": False,
            "network_access_present": False,
        }

    def _receipt(
        self,
        *,
        ok: bool,
        reason_code: str,
        staged: bool = False,
        replay_recorded: bool = False,
        read_chain_sha256: str | None = None,
    ) -> dict[str, Any]:
        """Build a receipt. It never contains input, paths, the chain or the bundle."""
        receipt: dict[str, Any] = {
            "schema": RECEIPT_SCHEMA,
            "ok": ok,
            "accepted": ok,
            "rejected": not ok,
            "reason_code": reason_code,
            "staged": staged,
            "replay_recorded": replay_recorded,
            "input_fired": False,
            "desktop_state_touched": False,
            "owner_gated": False,
            "contract_sha256_prefix": STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
        }
        if read_chain_sha256 is not None:
            receipt["read_chain_sha256_prefix"] = read_chain_sha256[:HASH_PREFIX_LENGTH]
        return receipt

    def reject_receipt(self, reason_code: str) -> dict[str, Any]:
        """Return the receipt for a refused proposal."""
        return self._receipt(ok=False, reason_code=reason_code)

    def _validate_read_chain(self, value: Any) -> tuple[Mapping[str, Any], str]:
        chain = _closed_object(value, READ_CHAIN_FIELDS)
        _exact_string(chain["schema"], SCHEMA_NAME)
        _exact_string(chain["arm"], READ_CHAIN_ARM)
        _opaque_id(chain["scope_id"])
        prefix = _prefix(chain["scope_contract_sha256_prefix"])
        _sha256(chain["issuer_receipt_sha256"])
        _sha256(chain["observation_receipt_sha256"])
        issued_at = _integer(chain["issued_at_unix_ms"])
        expires_at = _integer(chain["expires_at_unix_ms"])
        _nonce(chain["nonce"])
        _sha256(chain["frame_sha256"])
        projection = _closed_object(chain["projection"], PROJECTION_FIELDS)
        _opaque_id(projection["target_ref"])
        candidate_count = _integer(projection["candidate_count"], maximum=1000)
        x = _integer(projection["x"], maximum=32767)
        y = _integer(projection["y"], maximum=32767)
        width = _integer(projection["screen_width"], minimum=1, maximum=32768)
        height = _integer(projection["screen_height"], minimum=1, maximum=32768)

        if self.read_scope_contract_sha256_prefix is None or self.read_chain_verifier is None:
            raise ContractError("read_scope_contract_unavailable")
        if prefix != self.read_scope_contract_sha256_prefix:
            raise ContractError("read_scope_contract_mismatch")

        now = self.now_ms()
        if issued_at > now + MAX_CLOCK_SKEW_MS:
            raise ContractError("scope_not_yet_valid")
        if expires_at <= now:
            raise ContractError("stale_scope")
        if expires_at <= issued_at or expires_at - issued_at > MAX_SCOPE_WINDOW_MS:
            raise ContractError("scope_window_invalid")
        # Exactly one candidate, on screen: an ambiguous observation cannot justify a click.
        if candidate_count != 1 or x >= width or y >= height:
            raise ContractError("projection_failure")

        chain_hash = sha256_hex(chain)
        try:
            authenticated = self.read_chain_verifier(chain, chain_hash)
        except ContractError:
            raise
        except Exception as exc:  # fail closed without exposing payload or exception text
            raise ContractError("read_chain_verifier_unavailable") from exc
        if authenticated is not True:
            raise ContractError("forged_observe_click")
        return chain, chain_hash

    def _validate_bundle(self, value: Any) -> Mapping[str, Any]:
        bundle = _closed_object(value, BUNDLE_FIELDS)
        _exact_string(bundle["schema"], SCHEMA_NAME)
        _exact_string(bundle["arm"], COMPUTER_BUNDLE_ARM)
        _opaque_id(bundle["scope_id"])
        mediator_prefix = _prefix(bundle["mediator_contract_sha256_prefix"])
        _sha256(bundle["read_chain_sha256"])
        _nonce(bundle["nonce"])
        action = _closed_object(bundle["action"], ACTION_FIELDS)
        _exact_string(action["operation"], "click")
        _opaque_id(action["target_ref"])
        _exact_string(action["button"], "left")
        if mediator_prefix != STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX:
            raise ContractError("mediator_contract_mismatch")
        return bundle

    def validate_pair(self, read_chain: Any, computer_bundle: Any) -> ValidatedPair:
        """Validate a read-chain and a bundle and check that the bundle is bound to the chain.

        The bundle must cite the chain's exact hash, scope id and projected target.

        Raises:
            ContractError: With the reason code of the first failed check.
        """
        chain, chain_hash = self._validate_read_chain(read_chain)
        bundle = self._validate_bundle(computer_bundle)
        projection = chain["projection"]
        action = bundle["action"]
        if (
            bundle["read_chain_sha256"] != chain_hash
            or bundle["scope_id"] != chain["scope_id"]
            or action["target_ref"] != projection["target_ref"]
        ):
            raise ContractError("forged_observe_click")
        # A read-chain is single-use. Keying replay protection to the chain (not to the bundle
        # nonce) stops an attacker from replaying one observation with a freshly chosen nonce.
        replay_key = hashlib.sha256(
            canonical_bytes(
                {
                    "read_chain_sha256": chain_hash,
                    "scope_id": chain["scope_id"],
                }
            )
        ).hexdigest()
        return ValidatedPair(chain, bundle, chain_hash, replay_key)

    def validate_json_pair(self, read_chain_json: str, computer_bundle_json: str) -> dict[str, Any]:
        """Validate two JSON documents without consuming anything.

        Returns:
            An ``accepted`` receipt, or a rejection receipt with the reason code.
        """
        try:
            pair = self.validate_pair(
                parse_json_object(read_chain_json),
                parse_json_object(computer_bundle_json),
            )
        except ContractError as exc:
            return self.reject_receipt(exc.reason_code)
        return self._receipt(
            ok=True,
            reason_code="accepted",
            read_chain_sha256=pair.read_chain_sha256,
        )

    def stage_json_pair(self, read_chain_json: str, computer_bundle_json: str) -> dict[str, Any]:
        """Validate two JSON documents and consume the proposal exactly once.

        Consumption is recorded *before* the receipt is returned, so a crash after staging can
        never allow the same proposal to be staged again. No desktop input is ever fired.

        Returns:
            A ``staged_no_input`` receipt on first use, ``replay`` on any later use, or a
            rejection receipt with the reason code.
        """
        try:
            pair = self.validate_pair(
                parse_json_object(read_chain_json),
                parse_json_object(computer_bundle_json),
            )
            consumed = self.replay_ledger.consume(pair.replay_key)
        except ContractError as exc:
            return self.reject_receipt(exc.reason_code)
        except ReplayStoreError as exc:
            return self.reject_receipt(str(exc))
        if not consumed:
            return self.reject_receipt("replay")
        return self._receipt(
            ok=True,
            reason_code="staged_no_input",
            staged=True,
            replay_recorded=True,
            read_chain_sha256=pair.read_chain_sha256,
        )
