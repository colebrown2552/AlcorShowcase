"""Sealed receipts: JSON documents that carry a SHA-256 of their own contents.

A receipt records what a run did (counts, hashes, commits; never page text). The seal makes a
careless edit visible: a receipt whose seal does not verify is treated as missing. It is not a
signature. Anyone who can write the file can recompute the seal, so the real protection against a
forged approval is the controller's one-time codes, not this module.
"""

from __future__ import annotations

import hmac
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .fsutil import canonical, read_json, sha256_bytes, write_json_atomic

SEAL_KEY = "receipt_sha256"


def seal(receipt: Mapping[str, Any]) -> dict[str, Any]:
    """Return a copy of ``receipt`` with its seal set over every other field."""
    body = {key: value for key, value in receipt.items() if key != SEAL_KEY}
    return {**body, SEAL_KEY: sha256_bytes(canonical(body).encode("utf-8"))}


def seal_ok(receipt: object) -> bool:
    """Return True if ``receipt`` is a mapping whose seal matches its contents."""
    if not isinstance(receipt, dict) or not isinstance(receipt.get(SEAL_KEY), str):
        return False
    body = {key: value for key, value in receipt.items() if key != SEAL_KEY}
    expected = sha256_bytes(canonical(body).encode("utf-8"))
    return hmac.compare_digest(receipt[SEAL_KEY], expected)


def write_sealed(path: Path, receipt: Mapping[str, Any]) -> dict[str, Any]:
    """Seal ``receipt``, write it atomically to ``path`` and return the sealed copy."""
    sealed = seal(receipt)
    write_json_atomic(path, sealed)
    return sealed


def read_sealed(path: Path) -> tuple[dict[str, Any] | None, str]:
    """Read a sealed receipt.

    Returns:
        ``(receipt, "")`` when the file exists and its seal verifies, otherwise ``(None, problem)``
        where ``problem`` says why the receipt cannot be trusted.
    """
    data = read_json(path)
    if data is None:
        return None, "missing or unreadable"
    if not seal_ok(data):
        return None, "seal does not match the contents (edited after it was written?)"
    return data, ""
