"""Privacy gate: detect and redact private data in text and JSON-compatible values.

``ledger.py`` calls this module before an entry is written, so a secret never reaches the file.
The central rule is that a detected value is never echoed back. A ``Finding`` carries only the
category, where the value was found, how long it was and a short SHA-256 fingerprint. That keeps
diagnostics safe to log and still lets an operator tell two findings apart.

The patterns are deliberately conservative. A false positive costs one rejected entry; a false
negative puts a secret into an append-only file that cannot be edited without breaking its chain.
They are a last line of defence, not a replacement for secret scanning at the hosting provider.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class Finding:
    """A potential disclosure found in a value or file.

    Attributes:
        label: Detector category, such as ``email`` or ``sensitive-key:password``.
        location: Where the value was found: a JSON path like ``$.metadata.token`` or a file path.
        start: Start offset of the match in the scanned text, or None for key-based findings.
        end: End offset of the match in the scanned text, or None for key-based findings.
        length: Length of the matched value. The value itself is never stored.
        fingerprint: First 12 hex characters of the value's SHA-256.
    """

    label: str
    location: str
    start: int | None
    end: int | None
    length: int
    fingerprint: str

    def as_dict(self) -> dict[str, Any]:
        """Return the finding as a JSON-serialisable dictionary."""
        return {
            "label": self.label,
            "location": self.location,
            "start": self.start,
            "end": self.end,
            "length": self.length,
            "fingerprint": self.fingerprint,
        }


@dataclass(frozen=True, slots=True)
class ScanResult:
    """The outcome of scanning one file.

    Attributes:
        path: The path that was scanned.
        findings: Everything the detectors found.
        skipped: True when the file was not scanned at all.
        reason: Why the file was skipped, as a short code.
    """

    path: str
    findings: tuple[Finding, ...]
    skipped: bool = False
    reason: str | None = None

    @property
    def safe(self) -> bool:
        """True only when the file was scanned and nothing was found.

        A skipped file is not "safe": it was never looked at.
        """
        return not self.findings and not self.skipped


# Each spec is (label, pattern, flags). Lookarounds keep a detector from firing inside a longer
# token, for example the address detector ignores digits that belong to a larger number.
_PATTERN_SPECS: tuple[tuple[str, str, int], ...] = (
    ("private-key", r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----", re.IGNORECASE),
    ("credentialed-url", r"\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@", re.IGNORECASE),
    ("bearer-token", r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", re.IGNORECASE),
    ("github-token", r"\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b", 0),
    ("api-key", r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b", 0),
    ("email", r"(?<![\w.+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![\w.-])", re.IGNORECASE),
    ("windows-user-home", r"\b[A-Z]:\\Users\\[^\\/\r\n\t ]+", re.IGNORECASE),
    ("unix-user-home", r"(?<![\w.-])/(?:home|Users)/[^/\s]+", 0),
    (
        "ipv4",
        r"(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)",
        0,
    ),
    ("mac-address", r"(?<![0-9A-F])(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}(?![0-9A-F])", re.IGNORECASE),
)

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (label, re.compile(pattern, flags)) for label, pattern, flags in _PATTERN_SPECS
)

# A value stored under one of these keys is blocked whatever it looks like: a field named
# "password" is private even when its value is harmless-looking. Keys are compared after
# normalisation, so "API-Key" and "api_key" are the same key.
_SENSITIVE_KEYS = frozenset(
    {
        "access_key",
        "access_token",
        "api_key",
        "apikey",
        "authorization",
        "client_secret",
        "cookie",
        "credentials",
        "device_id",
        "email",
        "home_path",
        "host",
        "hostname",
        "ip_address",
        "machine_id",
        "mac_address",
        "owner",
        "password",
        "passwd",
        "phone",
        "private_key",
        "refresh_token",
        "secret",
        "serial_number",
        "session",
        "session_id",
        "token",
        "user",
        "user_name",
        "username",
    }
)

# Replacement written in place of a sensitive-key value. Recognising it again makes redaction
# idempotent: redacting an already-redacted value does not report a new finding.
_SENSITIVE_KEY_MARKER_PREFIX = "<REDACTED:SENSITIVE-KEY:"

_TEXT_EXTENSIONS = frozenset(
    {
        ".bat",
        ".cfg",
        ".cmd",
        ".ini",
        ".json",
        ".jsonl",
        ".md",
        ".ps1",
        ".py",
        ".sh",
        ".text",
        ".toml",
        ".txt",
        ".yaml",
        ".yml",
    }
)

_TEXT_FILE_NAMES = frozenset({".env", ".gitignore", "Dockerfile", "Makefile"})


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:12]


def _finding(label: str, location: str, value: str, start: int | None, end: int | None) -> Finding:
    return Finding(
        label=label,
        location=location,
        start=start,
        end=end,
        length=len(value),
        fingerprint=_fingerprint(value),
    )


def scan_text(text: str, *, location: str = "$") -> tuple[Finding, ...]:
    """Find likely private data in ``text`` without returning the matched text.

    Args:
        text: The text to inspect.
        location: Label recorded on each finding, usually a JSON path or a file path.

    Returns:
        Findings ordered by position in the text, then by label.
    """
    findings: list[Finding] = []
    seen: set[tuple[str, int, int]] = set()
    for label, pattern in _PATTERNS:
        for match in pattern.finditer(text):
            key = (label, match.start(), match.end())
            if key in seen:
                continue
            seen.add(key)
            findings.append(_finding(label, location, match.group(0), match.start(), match.end()))
    findings.sort(key=lambda item: (item.start if item.start is not None else -1, item.label))
    return tuple(findings)


def redact_text(text: str, *, location: str = "$") -> tuple[str, tuple[Finding, ...]]:
    """Replace detected values in ``text`` and keep the surrounding text.

    Args:
        text: The text to redact.
        location: Label recorded on each finding.

    Returns:
        The redacted text and the findings that caused each replacement. Unchanged text is
        returned as is when nothing was found.
    """
    findings = list(scan_text(text, location=location))
    if not findings:
        return text, ()

    # Overlapping or touching matches collapse into one range, otherwise replacing the first
    # would shift the offsets of the second. The marker names every detector involved and never
    # the secret itself.
    ranges: list[tuple[int, int, set[str]]] = []
    for finding in findings:
        # Text findings always carry offsets; only key-based findings (see scan_value) do not.
        assert finding.start is not None and finding.end is not None
        if ranges and finding.start <= ranges[-1][1]:
            start, end, labels = ranges[-1]
            ranges[-1] = (start, max(end, finding.end), labels | {finding.label})
        else:
            ranges.append((finding.start, finding.end, {finding.label}))

    # Replace from the end so earlier offsets stay valid.
    result = text
    for start, end, labels in reversed(ranges):
        marker = "<REDACTED:" + "+".join(sorted(labels)).upper() + ">"
        result = result[:start] + marker + result[end:]
    return result, tuple(findings)


def _normalized_key(key: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(key).strip().lower()).strip("_")


def _blocked_key(key: Any, child: Any) -> str | None:
    """Return the normalised key when ``child`` is a non-empty value under a sensitive key.

    Empty values carry no data, so they pass. A value that is already a redaction marker also
    passes, which is what makes redacting twice a no-op.
    """
    normalized = _normalized_key(key)
    if normalized not in _SENSITIVE_KEYS:
        return None
    if child in (None, "", [], {}):
        return None
    if isinstance(child, str) and child.startswith(_SENSITIVE_KEY_MARKER_PREFIX):
        return None
    return normalized


def _encode_for_fingerprint(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


def scan_value(value: Any, *, location: str = "$") -> tuple[Finding, ...]:
    """Recursively inspect JSON-compatible data.

    Strings are scanned with the text detectors. Values stored under a sensitive key are reported
    as one finding for the whole value, without looking inside it.

    Args:
        value: Nested mappings, lists, tuples and strings. Other types are ignored.
        location: JSON path of ``value``, extended as the scan descends.

    Returns:
        All findings, in document order.
    """
    findings: list[Finding] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            child_location = f"{location}.{key}"
            blocked = _blocked_key(key, child)
            if blocked is not None:
                findings.append(
                    _finding(
                        f"sensitive-key:{blocked}",
                        child_location,
                        _encode_for_fingerprint(child),
                        None,
                        None,
                    )
                )
            else:
                findings.extend(scan_value(child, location=child_location))
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            findings.extend(scan_value(child, location=f"{location}[{index}]"))
    elif isinstance(value, str):
        findings.extend(scan_text(value, location=location))
    return tuple(findings)


def redact_value(value: Any, *, location: str = "$") -> tuple[Any, tuple[Finding, ...]]:
    """Recursively redact JSON-compatible data.

    Values under a sensitive key are replaced wholesale rather than partially redacted, because
    the key already says the whole value is private. The input is not modified.

    Args:
        value: Nested mappings, lists, tuples and strings.
        location: JSON path of ``value``, extended as the walk descends.

    Returns:
        A redacted copy and the findings behind each replacement. Mapping keys are converted to
        strings, as they would be when written as JSON.
    """
    findings: list[Finding] = []
    if isinstance(value, Mapping):
        clean: dict[str, Any] = {}
        for key, child in value.items():
            child_location = f"{location}.{key}"
            blocked = _blocked_key(key, child)
            if blocked is not None:
                findings.append(
                    _finding(
                        f"sensitive-key:{blocked}",
                        child_location,
                        _encode_for_fingerprint(child),
                        None,
                        None,
                    )
                )
                clean[str(key)] = f"{_SENSITIVE_KEY_MARKER_PREFIX}{blocked.upper()}>"
            else:
                redacted_child, child_findings = redact_value(child, location=child_location)
                clean[str(key)] = redacted_child
                findings.extend(child_findings)
        return clean, tuple(findings)
    if isinstance(value, (list, tuple)):
        items: list[Any] = []
        for index, child in enumerate(value):
            redacted_child, child_findings = redact_value(child, location=f"{location}[{index}]")
            items.append(redacted_child)
            findings.extend(child_findings)
        return (tuple(items) if isinstance(value, tuple) else items), tuple(findings)
    if isinstance(value, str):
        return redact_text(value, location=location)
    return value, ()


def _scan_structured_text(text: str, suffix: str, location: str) -> tuple[Finding, ...]:
    """Scan raw text, and additionally the parsed data for JSON and JSON Lines files.

    Parsing catches sensitive *keys*, which a plain text scan cannot see. Unparseable JSON still
    gets the plain text scan, so a broken file is never treated as clean.
    """
    findings: list[Finding] = list(scan_text(text, location=location))
    if suffix == ".json":
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return tuple(findings)
        findings.extend(scan_value(value, location=location))
    elif suffix == ".jsonl":
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            findings.extend(scan_value(value, location=f"{location}:{line_number}"))
    return tuple(findings)


def scan_file(path: str | Path, *, max_bytes: int = 2_000_000) -> ScanResult:
    """Scan one likely-text file.

    Binary, oversized, unreadable or unsupported files are reported as skipped rather than
    treated as safe.

    Args:
        path: File to scan.
        max_bytes: Files larger than this are skipped.

    Returns:
        The findings, or a skipped result with a short reason code.
    """
    file_path = Path(path)
    if file_path.suffix.lower() not in _TEXT_EXTENSIONS and file_path.name not in _TEXT_FILE_NAMES:
        return ScanResult(str(file_path), (), skipped=True, reason="unsupported-extension")
    try:
        size = file_path.stat().st_size
    except OSError as exc:
        return ScanResult(
            str(file_path), (), skipped=True, reason=f"stat-error:{type(exc).__name__}"
        )
    if size > max_bytes:
        return ScanResult(str(file_path), (), skipped=True, reason="too-large")
    try:
        raw = file_path.read_bytes()
    except OSError as exc:
        return ScanResult(
            str(file_path), (), skipped=True, reason=f"read-error:{type(exc).__name__}"
        )
    if b"\x00" in raw:
        return ScanResult(str(file_path), (), skipped=True, reason="binary")
    text = raw.decode("utf-8", errors="replace")
    return ScanResult(
        str(file_path),
        _scan_structured_text(text, file_path.suffix.lower(), str(file_path)),
    )


def iter_files(paths: Iterable[str | Path]) -> Iterator[Path]:
    """Yield files under ``paths`` in a stable order, skipping version-control internals.

    Each file is yielded once even if several arguments reach it.
    """
    seen: set[Path] = set()
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_file():
            resolved = path.resolve()
            if resolved not in seen:
                seen.add(resolved)
                yield path
            continue
        if not path.exists():
            continue
        for candidate in sorted(path.rglob("*")):
            if not candidate.is_file() or ".git" in candidate.parts:
                continue
            resolved = candidate.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            yield candidate


def scan_paths(
    paths: Iterable[str | Path], *, max_bytes: int = 2_000_000
) -> tuple[ScanResult, ...]:
    """Scan every file reachable from ``paths`` and return one result per file."""
    return tuple(scan_file(path, max_bytes=max_bytes) for path in iter_files(paths))
