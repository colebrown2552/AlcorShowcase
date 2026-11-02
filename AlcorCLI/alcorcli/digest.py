"""Canonical JSON and SHA-256 helpers used by every receipt.

A digest is only useful if two parties compute it from the same bytes. This module fixes the one
encoding the gate uses: sorted keys, no whitespace, strict JSON (no NaN or Infinity).
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


def canonical_json(value: Any) -> str:
    """Encode ``value`` as canonical JSON text.

    Raises:
        ValueError: If the value holds NaN or Infinity.
        TypeError: If the value is not JSON serialisable.
    """
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    )


def sha256_hex(value: Any) -> str:
    """Return the hex SHA-256 of bytes, text, or the canonical JSON of any other value."""
    if isinstance(value, bytes):
        payload = value
    elif isinstance(value, str):
        payload = value.encode("utf-8")
    else:
        payload = canonical_json(value).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def utc_iso(epoch: float) -> str:
    """Format an epoch time as an ISO-8601 UTC string with second precision."""
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
