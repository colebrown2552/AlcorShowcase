"""Turn adapter output into bounded, fingerprinted observations.

Adapters are the only code that touches real data, and they are trusted no further than the
operator is: whatever an adapter returns is type-checked, size-checked against the global cap,
cut down to the action's byte cap, and fingerprinted before any receipt is written.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

from .contract import (
    HASH_PREFIX_LENGTH,
    MAX_SCOPE_BYTES,
    AuthorityError,
    _truncate_utf8,
)
from .values import BoundedObservation, ObservationAdapter


def adapt_search(adapter: ObservationAdapter, action: Mapping[str, Any]) -> BoundedObservation:
    """Run a validated ``search`` action and bound the result.

    The fingerprint covers all returned text, but only the first ``max_bytes`` bytes are kept in
    the observation body, so the receipt can prove what was seen without storing it.

    Args:
        adapter: The data source.
        action: A normalised action from ``validate_read_operator_output``.

    Returns:
        The bounded observation.

    Raises:
        AuthorityError: ``adapter_unavailable``, ``adapter_invalid`` (wrong types) or
            ``adapter_cap_exceeded`` (too many results or too many total bytes).
    """
    try:
        results = adapter.search(action["path"], action["query"], action["max_results"])
    except AuthorityError:
        raise
    except Exception as exc:
        raise AuthorityError("adapter_unavailable") from exc
    if not isinstance(results, (list, tuple)) or any(not isinstance(item, str) for item in results):
        raise AuthorityError("adapter_invalid")
    if len(results) > action["max_results"]:
        raise AuthorityError("adapter_cap_exceeded")
    digest = hashlib.sha256()
    bounded_bytes = bytearray()
    total_bytes = 0
    for index, item in enumerate(results):
        encoded = (("\n" if index else "") + item).encode("utf-8")
        total_bytes += len(encoded)
        if total_bytes > MAX_SCOPE_BYTES:
            raise AuthorityError("adapter_cap_exceeded")
        digest.update(encoded)
        remaining = action["max_bytes"] - len(bounded_bytes)
        if remaining > 0:
            bounded_bytes.extend(encoded[:remaining])
    bounded = bytes(bounded_bytes).decode("utf-8", errors="ignore")
    return BoundedObservation(
        result_count=len(results),
        content_sha256_prefix=digest.hexdigest()[:HASH_PREFIX_LENGTH],
        body_truncated_to_cap=bounded,
        body_was_truncated=total_bytes > action["max_bytes"],
    )


def adapt_read(adapter: ObservationAdapter, action: Mapping[str, Any]) -> BoundedObservation:
    """Run a validated ``read`` action and bound the result.

    Args:
        adapter: The data source.
        action: A normalised action from ``validate_read_operator_output``.

    Returns:
        The bounded observation (``result_count`` is always 1).

    Raises:
        AuthorityError: ``adapter_unavailable``, ``adapter_invalid`` or ``adapter_cap_exceeded``.
    """
    try:
        body = adapter.read(action["path"])
    except AuthorityError:
        raise
    except Exception as exc:
        raise AuthorityError("adapter_unavailable") from exc
    if not isinstance(body, str):
        raise AuthorityError("adapter_invalid")
    encoded = body.encode("utf-8")
    if len(encoded) > MAX_SCOPE_BYTES:
        raise AuthorityError("adapter_cap_exceeded")
    bounded, truncated = _truncate_utf8(body, action["max_bytes"])
    return BoundedObservation(
        result_count=1,
        content_sha256_prefix=hashlib.sha256(encoded).hexdigest()[:HASH_PREFIX_LENGTH],
        body_truncated_to_cap=bounded,
        body_was_truncated=truncated,
    )
