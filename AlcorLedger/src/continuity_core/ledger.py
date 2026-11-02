"""Tamper-evident, privacy-gated JSONL ledgers.

A ledger is a text file with one JSON object per line. Every entry stores the SHA-256 of the entry
before it (``previous_hash``) and its own SHA-256 (``entry_hash``). Changing, removing or
reordering a line therefore breaks the chain from that point on, and ``JsonlLedger.verify`` says
which line.

Three rules shape the code:

* Fail closed. An entry is schema-checked and privacy-scanned before it is written, and the whole
  file is re-verified before every append, so a damaged ledger is never extended.
* Deterministic bytes. Entries are stored as canonical JSON (sorted keys, no extra whitespace), so
  an entry's hash depends only on its data, on any machine.
* Standard library only. Writers are serialised with an exclusive lock file rather than a
  platform-specific locking package.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .redaction import Finding, redact_value, scan_value

SCHEMA_VERSION = 1

# Hash that the first entry of every ledger points back to.
ZERO_HASH = "0" * 64

_ALLOWED_STATUSES: dict[str, frozenset[str]] = {
    "memory": frozenset({"active", "expired", "retracted", "superseded"}),
    "observation": frozenset({"archived", "confirmed", "disproved", "open"}),
    "decision": frozenset({"accepted", "reversed", "superseded"}),
    "wishlist": frozenset(
        {"accepted", "completed", "in_progress", "proposed", "rejected", "superseded"}
    ),
}

_DEFAULT_STATUS: dict[str, str] = {
    "memory": "active",
    "observation": "open",
    "decision": "accepted",
    "wishlist": "proposed",
}

_ALLOWED_PROVENANCE = frozenset({"analysis", "imported", "operator", "runtime", "test"})

# The fields a caller may supply. Anything else is rejected rather than silently dropped, so a
# typo such as "autority" cannot pass unnoticed.
_ALLOWED_INPUT_FIELDS = frozenset(
    {
        "confidence",
        "created_at",
        "expires_at",
        "id",
        "kind",
        "metadata",
        "provenance",
        "statement",
        "status",
        "supersedes",
        "tags",
    }
)

# The exact field set of a stored line: the caller's fields plus the three the ledger adds.
_STORED_FIELDS = _ALLOWED_INPUT_FIELDS | frozenset(
    {"schema_version", "previous_hash", "entry_hash"}
)

# Threads in this process queue on an in-memory lock per ledger path. The lock file (see
# _exclusive_lock) then serialises writers across processes.
_PROCESS_LOCK_GUARD = threading.Lock()
_PROCESS_LOCKS: dict[str, threading.RLock] = {}


def _process_lock(path: Path) -> threading.RLock:
    key = str(path.resolve())
    with _PROCESS_LOCK_GUARD:
        return _PROCESS_LOCKS.setdefault(key, threading.RLock())


class LedgerError(Exception):
    """Base class for ledger failures."""


class ValidationError(LedgerError):
    """An entry violates the ledger schema."""


class SensitiveDataError(LedgerError):
    """An entry appears to contain private data.

    The message names the categories only. ``findings`` carries locations and fingerprints, never
    the matched values.

    Attributes:
        findings: What the privacy gate detected.
    """

    def __init__(self, findings: Iterable[Finding]) -> None:
        self.findings = tuple(findings)
        labels = ", ".join(sorted({finding.label for finding in self.findings}))
        super().__init__(f"entry contains blocked data categories: {labels}")


class ChainError(LedgerError):
    """A ledger's hash chain is invalid, or a line cannot be parsed."""


@dataclass(frozen=True, slots=True)
class VerificationReport:
    """The result of verifying one ledger file.

    Attributes:
        path: The ledger path that was checked.
        entries: Number of non-blank lines examined.
        errors: One human-readable message per problem, each starting with ``line N:``.
    """

    path: str
    entries: int
    errors: tuple[str, ...]

    @property
    def ok(self) -> bool:
        """True when no problem was found."""
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        """Return the report as a JSON-serialisable dictionary."""
        return {
            "path": self.path,
            "entries": self.entries,
            "ok": self.ok,
            "errors": list(self.errors),
        }


def utc_now() -> str:
    """Return the current UTC time as an ISO-8601 string with a ``Z`` suffix."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_timestamp(value: str, field: str) -> str:
    """Validate an ISO-8601 timestamp and normalise it to UTC with a ``Z`` suffix."""
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field} must be a non-empty ISO-8601 string")
    normalized = value.strip()
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(f"{field} must be ISO-8601") from exc
    if parsed.tzinfo is None:
        # A naive time cannot be ordered against other entries without guessing a zone.
        raise ValidationError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _canonical_json(value: Mapping[str, Any]) -> str:
    """Serialise ``value`` so equal data always gives identical bytes.

    The hash and the stored line both depend on this exact form: sorted keys, no whitespace,
    non-ASCII kept as UTF-8. Changing it would invalidate every existing ledger.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _entry_hash(entry_without_hash: Mapping[str, Any]) -> str:
    """Hash an entry with its own ``entry_hash`` field removed.

    ``previous_hash`` is part of the hashed data, so each entry commits to the whole chain before
    it, not just to its own content.
    """
    return hashlib.sha256(_canonical_json(entry_without_hash).encode("utf-8")).hexdigest()


def is_sha256_hex(value: Any) -> bool:
    """Return True if ``value`` is a lowercase 64-character hexadecimal string."""
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _normalize_string_list(value: Any, field: str, *, max_items: int = 64) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError(f"{field} must be a list")
    if len(value) > max_items:
        raise ValidationError(f"{field} may contain at most {max_items} items")
    clean: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValidationError(f"{field} items must be non-empty strings")
        normalized = item.strip()
        if len(normalized) > 200:
            raise ValidationError(f"{field} items may not exceed 200 characters")
        if normalized not in seen:
            seen.add(normalized)
            clean.append(normalized)
    return clean


def _normalize_provenance(value: Any) -> dict[str, str]:
    if value is None:
        return {"type": "analysis"}
    if isinstance(value, str):
        value = {"type": value}
    if not isinstance(value, Mapping):
        raise ValidationError("provenance must be a string or object")
    extra = set(value) - {"type", "reference"}
    if extra:
        names = ", ".join(sorted(map(str, extra)))
        raise ValidationError(f"unsupported provenance fields: {names}")
    provenance_type = str(value.get("type", "")).strip().lower()
    if provenance_type not in _ALLOWED_PROVENANCE:
        raise ValidationError(
            "provenance.type must be one of " + ", ".join(sorted(_ALLOWED_PROVENANCE))
        )
    result = {"type": provenance_type}
    reference = value.get("reference")
    if reference is not None:
        if not isinstance(reference, str) or not reference.strip():
            raise ValidationError("provenance.reference must be a non-empty string")
        if len(reference.strip()) > 240:
            raise ValidationError("provenance.reference may not exceed 240 characters")
        result["reference"] = reference.strip()
    return result


def normalize_entry(source: Mapping[str, Any], *, redact: bool = False) -> dict[str, Any]:
    """Validate an unchained entry and return it in stored form (without hashes).

    A public ledger is assumed to be breached, so sensitive content is rejected by default.
    Callers must ask for redaction explicitly: silently rewriting a statement could hide a bad
    upstream data flow.

    Args:
        source: The entry as supplied by the caller. Unknown fields are rejected.
        redact: Replace blocked data with ``<REDACTED:...>`` markers instead of rejecting.

    Returns:
        The normalised entry with defaults filled in (``id``, ``created_at``, ``status``).

    Raises:
        ValidationError: A field is missing, malformed or out of range.
        SensitiveDataError: The entry holds private data and ``redact`` is False, or data
            remained after redaction.
    """
    if not isinstance(source, Mapping):
        raise ValidationError("entry must be an object")
    unknown = set(source) - _ALLOWED_INPUT_FIELDS
    if unknown:
        raise ValidationError(f"unsupported fields: {', '.join(sorted(map(str, unknown)))}")

    kind = str(source.get("kind", "")).strip().lower()
    if kind not in _ALLOWED_STATUSES:
        raise ValidationError("kind must be memory, observation, decision, or wishlist")

    statement = source.get("statement")
    if not isinstance(statement, str) or not statement.strip():
        raise ValidationError("statement must be a non-empty string")
    statement = statement.strip()
    if len(statement) > 8_000:
        raise ValidationError("statement may not exceed 8,000 characters")

    status = str(source.get("status", _DEFAULT_STATUS[kind])).strip().lower()
    if status not in _ALLOWED_STATUSES[kind]:
        raise ValidationError(
            f"status for {kind} must be one of {', '.join(sorted(_ALLOWED_STATUSES[kind]))}"
        )

    confidence = source.get("confidence", 1.0 if kind == "decision" else 0.5)
    # bool is a subclass of int, so True would otherwise pass as a confidence of 1.
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise ValidationError("confidence must be a number from 0 through 1")
    confidence = float(confidence)
    if not 0.0 <= confidence <= 1.0:
        raise ValidationError("confidence must be a number from 0 through 1")

    entry_id = source.get("id", str(uuid4()))
    if not isinstance(entry_id, str) or not entry_id.strip():
        raise ValidationError("id must be a non-empty string")
    entry_id = entry_id.strip()
    if len(entry_id) > 160:
        raise ValidationError("id may not exceed 160 characters")

    metadata = source.get("metadata", {})
    if not isinstance(metadata, Mapping):
        raise ValidationError("metadata must be an object")
    try:
        # Round-trip to enforce JSON compatibility and to detach caller-owned data. Deeply nested
        # input raises RecursionError, which is reported as invalid metadata like any other.
        metadata = json.loads(json.dumps(metadata, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValidationError("metadata must be JSON-compatible") from exc

    normalized: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "id": entry_id,
        "kind": kind,
        "status": status,
        "statement": statement,
        "confidence": confidence,
        "provenance": _normalize_provenance(source.get("provenance")),
        "tags": _normalize_string_list(source.get("tags"), "tags"),
        "supersedes": _normalize_string_list(source.get("supersedes"), "supersedes"),
        "metadata": metadata,
        "created_at": _parse_timestamp(source.get("created_at", utc_now()), "created_at"),
        "expires_at": None,
    }
    if source.get("expires_at") is not None:
        normalized["expires_at"] = _parse_timestamp(source["expires_at"], "expires_at")

    findings = scan_value(normalized)
    if findings and not redact:
        raise SensitiveDataError(findings)
    if findings:
        normalized, _ = redact_value(normalized)
        # Re-scan the redacted copy: a replacement must never leave a detectable value behind.
        remaining = scan_value(normalized)
        if remaining:
            raise SensitiveDataError(remaining)
    return normalized


@contextmanager
def _exclusive_lock(
    path: Path,
    *,
    timeout: float = 30.0,
    stale_after: float = 120.0,
) -> Iterator[None]:
    """Serialise writers of ``path`` across threads and processes.

    The lock is a sidecar file created with ``O_EXCL``, which is atomic on every platform, so no
    locking package is needed. A lock older than ``stale_after`` seconds is assumed to belong to
    a crashed writer and is broken.

    Known gap: if two waiters break the same stale lock at the same instant, both can enter. That
    needs a crashed writer plus exact timing, and the damage is not silent. The two new lines can
    share a ``previous_hash``, ``verify`` reports it, and every later append refuses to extend
    the ledger.
    """
    lock_path = path.with_name(path.name + ".lock")
    with _process_lock(path):
        deadline = time.monotonic() + timeout
        while True:
            descriptor: int | None = None
            try:
                descriptor = os.open(
                    lock_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                payload = f"pid={os.getpid()} created={utc_now()}\n".encode()
                os.write(descriptor, payload)
                break
            except FileExistsError:
                try:
                    age = time.time() - lock_path.stat().st_mtime
                    if age > stale_after:
                        lock_path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise LedgerError(f"timed out waiting for ledger lock: {lock_path}") from None
                time.sleep(0.05)
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        try:
            yield
        finally:
            # Windows can briefly keep a just-closed file handle alive. A bounded retry stops
            # that transient condition from leaving a stale lock behind.
            for attempt in range(10):
                try:
                    lock_path.unlink()
                    break
                except FileNotFoundError:
                    break
                except PermissionError:
                    if attempt == 9:
                        raise
                    time.sleep(0.02 * (attempt + 1))


class JsonlLedger:
    """Append-only JSONL ledger with a SHA-256 hash chain.

    Args:
        path: Location of the ledger file. It is created on the first append.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def _verified_state(self) -> tuple[str, set[str]]:
        """Return the chain tail and the set of used ids, refusing damaged state.

        ``verify`` stays the single definition of "valid"; the second pass only collects values.
        """
        if not self.path.exists() or self.path.stat().st_size == 0:
            return ZERO_HASH, set()
        report = self.verify()
        if not report.ok:
            summary = "; ".join(report.errors[:3])
            raise ChainError(f"refusing to append to invalid ledger: {summary}")

        tail = ZERO_HASH
        identifiers: set[str] = set()
        for entry in self.entries():
            identifiers.add(entry["id"])
            tail = entry["entry_hash"]
        return tail, identifiers

    def _ends_mid_line(self) -> bool:
        """Return True if the file is non-empty and its last byte is not a newline.

        A copied or hand-edited ledger can lose its final newline and still verify. Appending
        straight after it would join two JSON objects on one line and corrupt the chain.
        """
        try:
            with self.path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    return False
                handle.seek(-1, os.SEEK_END)
                return handle.read(1) != b"\n"
        except FileNotFoundError:
            return False

    def append(self, source: Mapping[str, Any], *, redact: bool = False) -> dict[str, Any]:
        """Validate, chain and durably append one entry.

        The sequence is: normalise and privacy-scan (nothing is written if this fails), take the
        write lock, verify the existing file, link to its last hash, write one line and fsync.

        Args:
            source: The entry fields. See ``normalize_entry``.
            redact: Replace blocked data instead of rejecting the entry.

        Returns:
            The stored entry, including ``previous_hash`` and ``entry_hash``.

        Raises:
            ValidationError: The entry is invalid, or its id is already in the ledger.
            SensitiveDataError: The entry holds private data and ``redact`` is False.
            ChainError: The existing ledger fails verification.
            LedgerError: The write lock could not be taken in time.
        """
        normalized = normalize_entry(source, redact=redact)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _exclusive_lock(self.path):
            previous_hash, identifiers = self._verified_state()
            if normalized["id"] in identifiers:
                raise ValidationError("id already exists in ledger")
            entry = {**normalized, "previous_hash": previous_hash}
            entry["entry_hash"] = _entry_hash(entry)
            encoded = _canonical_json(entry) + "\n"
            if self._ends_mid_line():
                encoded = "\n" + encoded
            # newline="\n" keeps the bytes identical on Windows, where text mode would write CRLF.
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
        return entry

    def entries(self) -> Iterator[dict[str, Any]]:
        """Yield stored entries in order without verifying the chain.

        Raises:
            ChainError: A line is not valid JSON or not a JSON object.
        """
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ChainError(f"invalid JSON at line {line_number}") from exc
                if not isinstance(value, dict):
                    raise ChainError(f"line {line_number} is not an object")
                yield value

    def query(
        self,
        *,
        kind: str | None = None,
        status: str | None = None,
        tag: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield entries matching every filter that is given.

        Args:
            kind: Keep only entries of this kind.
            status: Keep only entries with this status.
            tag: Keep only entries carrying this tag.
        """
        for entry in self.entries():
            if kind is not None and entry.get("kind") != kind:
                continue
            if status is not None and entry.get("status") != status:
                continue
            if tag is not None and tag not in entry.get("tags", []):
                continue
            yield entry

    def verify(self) -> VerificationReport:
        """Check the whole file and report every problem found.

        For each line this checks the stored field set, the link to the previous entry, the
        entry's own hash, id uniqueness, the privacy policy and the schema. A bad line does not
        stop the scan, so one run lists all damage.

        Returns:
            A report whose ``errors`` is empty when the ledger is intact. A missing file is an
            error, not an empty ledger.
        """
        errors: list[str] = []
        expected_previous = ZERO_HASH
        identifiers: set[str] = set()
        count = 0
        if not self.path.exists():
            return VerificationReport(str(self.path), 0, ("ledger does not exist",))

        with self.path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                count += 1
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    errors.append(f"line {line_number}: invalid JSON")
                    continue
                if not isinstance(entry, dict):
                    errors.append(f"line {line_number}: expected object")
                    continue

                missing_fields = _STORED_FIELDS - set(entry)
                extra_fields = set(entry) - _STORED_FIELDS
                if missing_fields:
                    errors.append(
                        f"line {line_number}: missing fields [{','.join(sorted(missing_fields))}]"
                    )
                if extra_fields:
                    errors.append(
                        f"line {line_number}: unsupported stored fields "
                        f"[{','.join(sorted(map(str, extra_fields)))}]"
                    )

                if entry.get("schema_version") != SCHEMA_VERSION:
                    errors.append(f"line {line_number}: unsupported schema_version")
                previous_hash = entry.get("previous_hash")
                if not is_sha256_hex(previous_hash):
                    errors.append(f"line {line_number}: invalid previous_hash format")
                if previous_hash != expected_previous:
                    errors.append(f"line {line_number}: previous_hash mismatch")

                claimed_hash = entry.get("entry_hash")
                if not is_sha256_hex(claimed_hash):
                    errors.append(f"line {line_number}: invalid entry_hash format")
                without_hash = dict(entry)
                without_hash.pop("entry_hash", None)
                computed_hash = _entry_hash(without_hash)
                if claimed_hash != computed_hash:
                    errors.append(f"line {line_number}: entry_hash mismatch")
                # Link the next line to what this line CLAIMS to be, not to what it should be.
                # Then an edit to one line is reported once, on that line, instead of making
                # every later line look broken too.
                if isinstance(claimed_hash, str) and len(claimed_hash) == 64:
                    expected_previous = claimed_hash
                else:
                    expected_previous = computed_hash

                entry_id = entry.get("id")
                if not isinstance(entry_id, str) or not entry_id:
                    errors.append(f"line {line_number}: invalid id")
                elif entry_id in identifiers:
                    errors.append(f"line {line_number}: duplicate id")
                else:
                    identifiers.add(entry_id)

                findings = scan_value(entry)
                if findings:
                    labels = ",".join(sorted({finding.label for finding in findings}))
                    errors.append(f"line {line_number}: blocked data categories [{labels}]")

                # Re-run schema normalisation on the caller-supplied fields. This catches an
                # unsupported status or malformed metadata that a recomputed hash would hide.
                public_fields = {key: entry[key] for key in _ALLOWED_INPUT_FIELDS if key in entry}
                try:
                    normalize_entry(public_fields)
                except LedgerError as exc:
                    errors.append(f"line {line_number}: schema error: {exc}")

        return VerificationReport(str(self.path), count, tuple(errors))
