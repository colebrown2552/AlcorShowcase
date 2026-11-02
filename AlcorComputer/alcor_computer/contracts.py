"""Frozen, deterministic contracts for the computer-use mediator.

The three checked-in files in ``contracts/`` are loaded and hashed once at import time:

* the **union schema**: a discriminated union with exactly two closed arms, ``read-chain`` and
  ``computer bundle``;
* the **strict mediator contract**: what the mediator accepts (one left click, bound by hash);
* the **read-scope binding**: the pin that ties the mediator to the authority contract.

Their 12-digit hash prefixes are stamped on receipts and bundles, so a bundle written against a
different contract text is refused (``mediator_contract_mismatch``).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

SCHEMA_NAME = "alcor.computer.union.v1"
RECEIPT_SCHEMA = "alcor.computer.receipt.v1"
PLUGIN_SCHEMA = "alcor.computer.plugin.v1"
READ_SCOPE_BINDING_SCHEMA = "alcor.computer.read-scope-binding.v1"
READ_CHAIN_ARM = "read-chain"
COMPUTER_BUNDLE_ARM = "computer bundle"
HASH_PREFIX_LENGTH = 12


def canonical_bytes(value: Any) -> bytes:
    """Return stable UTF-8 JSON bytes (sorted keys, no spaces, no NaN) for hashes and receipts."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def sha256_hex(value: Any) -> str:
    """Return the SHA-256 hex digest of the canonical JSON form of ``value``."""
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def contracts_dir() -> Path:
    """Return the directory holding the checked-in contract files."""
    return Path(__file__).with_name("contracts")


def schema_path() -> Path:
    """Return the path of the union schema."""
    return contracts_dir() / "alcor_computer_union_v1.schema.json"


def strict_mediator_contract_path() -> Path:
    """Return the path of the strict mediator contract."""
    return contracts_dir() / "alcor_computer_strict_mediator_v1.json"


def read_scope_binding_path() -> Path:
    """Return the path of the read-scope binding pin."""
    return contracts_dir() / "alcor_read_scope_binding_v1.json"


def load_union_schema() -> dict[str, Any]:
    """Load the union schema as a dict."""
    return json.loads(schema_path().read_text(encoding="utf-8"))


def load_strict_mediator_contract() -> dict[str, Any]:
    """Load the strict mediator contract as a dict."""
    return json.loads(strict_mediator_contract_path().read_text(encoding="utf-8"))


def load_read_scope_binding() -> dict[str, Any]:
    """Load the read-scope binding pin as a dict."""
    return json.loads(read_scope_binding_path().read_text(encoding="utf-8"))


# The frozen handoff contract to whatever gated broker sits downstream. It is an interface
# description only: this package deliberately contains no input actuator and no method that
# could invoke one.
STRICT_MEDIATOR_CONTRACT = load_strict_mediator_contract()
STRICT_MEDIATOR_CONTRACT_SHA256 = sha256_hex(STRICT_MEDIATOR_CONTRACT)
STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX = STRICT_MEDIATOR_CONTRACT_SHA256[:HASH_PREFIX_LENGTH]

UNION_SCHEMA_SHA256 = sha256_hex(load_union_schema())
UNION_SCHEMA_SHA256_PREFIX = UNION_SCHEMA_SHA256[:HASH_PREFIX_LENGTH]
