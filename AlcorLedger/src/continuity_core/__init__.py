"""continuity-core: a hash-chained, append-only ledger with a privacy gate.

Typical use::

    from continuity_core import JsonlLedger

    ledger = JsonlLedger("memory/public.jsonl")
    ledger.append({"kind": "decision", "statement": "Receipts outrank narrative confidence."})
    assert ledger.verify().ok

The ``continuity`` command wraps the same API. See ``reconstruct`` for rebuilding a recorded
three-turn exchange from the chain, and ``redaction`` for the detectors behind the privacy gate.
"""

from .ledger import (
    ChainError,
    JsonlLedger,
    LedgerError,
    SensitiveDataError,
    ValidationError,
    VerificationReport,
    normalize_entry,
)
from .redaction import (
    Finding,
    ScanResult,
    redact_text,
    redact_value,
    scan_paths,
    scan_text,
    scan_value,
)

__all__ = [
    "ChainError",
    "Finding",
    "JsonlLedger",
    "LedgerError",
    "ScanResult",
    "SensitiveDataError",
    "ValidationError",
    "VerificationReport",
    "normalize_entry",
    "redact_text",
    "redact_value",
    "scan_paths",
    "scan_text",
    "scan_value",
]
