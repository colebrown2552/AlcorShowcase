"""Constants, path rules and receipt builders for the read-lane authority.

Every other module in this subpackage takes its vocabulary from here: schema ids, hard caps, the
reason-code carrying ``AuthorityError`` and the small validators that each trust boundary reuses.

The checked-in contract file is loaded and hashed once, at import time. The first 12 hex digits of
that hash are stamped on every scope token and receipt, so editing the contract invalidates every
token issued under the old text. The computer-use mediator pins the same prefix (see
``contracts/alcor_read_scope_binding_v1.json``) and refuses to run if the two disagree.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from fnmatch import fnmatchcase
from pathlib import PurePosixPath
from typing import Any

from ..contracts import contracts_dir, sha256_hex

READLANE_SCHEMA = "alcor.authority.readlane.v1"
BASE_RECEIPT_SCHEMA = "alcor.authority.receipt.v1"
CONTRACT_SCHEMA = "alcor.authority.readlane.contract.v1"
SCOPE_SCHEMA = "alcor.authority.readscope.v1"
OPERATOR_OUTPUT_SCHEMA = "alcor.authority.operator-output.v1"
TASK_INPUT_SCHEMA = "alcor.authority.task.v1"
HASH_PREFIX_LENGTH = 12
ALLOWED_VERBS = frozenset(("read", "search"))
# The order is the protocol: a chain with the same receipts in another order is not a valid chain.
READ_CHAIN_PHASES = ("prepared", "search", "read", "completed")
MAX_SCOPE_RESULTS = 1000
MAX_SCOPE_BYTES = 1024 * 1024
MAX_GLOBS = 32
MAX_ACTIONS = 2
MAX_QUERY_CHARS = 512

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PREFIX_RE = re.compile(r"^[0-9a-f]{12}$")
_OPAQUE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def _load_contract() -> dict[str, Any]:
    path = contracts_dir() / "alcor_authority_readlane_v1.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != CONTRACT_SCHEMA:
        raise RuntimeError("readlane_contract_invalid")
    return value


CONTRACT = _load_contract()
CONTRACT_SHA256 = sha256_hex(CONTRACT)
CONTRACT_SHA256_PREFIX = CONTRACT_SHA256[:HASH_PREFIX_LENGTH]


class AuthorityError(ValueError):
    """Fail-closed validation error that carries only a bounded reason code.

    The message is the reason code and nothing else, so an error can be turned into a receipt
    without leaking the offending input.

    Attributes:
        reason_code: Short snake_case code such as ``path_out_of_scope``.
    """

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


def _closed_mapping(value: Any, fields: Iterable[str]) -> Mapping[str, Any]:
    """Require a dict with exactly the named keys: unknown or missing keys are rejected."""
    required = frozenset(fields)
    if not isinstance(value, dict):
        raise AuthorityError("invalid_shape")
    keys = frozenset(value)
    if keys - required:
        raise AuthorityError("unknown_field")
    if required - keys:
        raise AuthorityError("missing_field")
    return value


def _bounded_int(value: Any, minimum: int, maximum: int) -> int:
    """Require an ``int`` in ``[minimum, maximum]``. ``bool`` is rejected on purpose."""
    if type(value) is not int or value < minimum or value > maximum:
        raise AuthorityError("invalid_cap")
    return value


def _exact_bool(value: Any) -> bool:
    """Require a real ``bool``: ``0``, ``1`` and ``"true"`` are not accepted."""
    if type(value) is not bool:
        raise AuthorityError("invalid_value")
    return value


def _normalize_repo_path(value: Any) -> str:
    """Return a relative POSIX path, or raise ``invalid_path``.

    Absolute paths, backslashes, NUL bytes and ``..`` segments are refused before any scope
    comparison happens, so a path cannot be written in a way that matches a glob it should not.
    """
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise AuthorityError("invalid_path")
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or any(part in ("", ".", "..") for part in candidate.parts):
        raise AuthorityError("invalid_path")
    normalized = candidate.as_posix()
    if normalized.startswith("/") or normalized == ".":
        raise AuthorityError("invalid_path")
    return normalized


def _normalize_glob(value: Any) -> str:
    """Normalise a scope glob like a path and refuse negated (``!``) patterns."""
    normalized = _normalize_repo_path(value)
    if normalized.startswith("!"):
        raise AuthorityError("invalid_scope")
    return normalized


def _path_in_scope(path: str, globs: Sequence[str]) -> bool:
    """Return True if ``path`` matches any glob.

    Matching uses ``fnmatch`` rules, where ``*`` also matches ``/``: ``src/*`` covers
    ``src/a/b.py``.
    """
    return any(fnmatchcase(path, pattern) for pattern in globs)


def _truncate_utf8(text: str, cap: int) -> tuple[str, bool]:
    """Cut ``text`` to at most ``cap`` UTF-8 bytes without splitting a character.

    Returns:
        The possibly shortened text and whether anything was removed.
    """
    encoded = text.encode("utf-8")
    if len(encoded) <= cap:
        return text, False
    return encoded[:cap].decode("utf-8", errors="ignore"), True


def _receipt(phase: str, ok: bool, reason_code: str, **fields: Any) -> dict[str, Any]:
    """Build one sanitised receipt.

    Receipts carry booleans, counts, reason codes and hash prefixes. They never carry paths,
    source text or credentials. ``live_state_touched`` is always False: nothing in this
    subpackage can reach live state.
    """
    value: dict[str, Any] = {
        "schema": READLANE_SCHEMA,
        "extends": BASE_RECEIPT_SCHEMA,
        "phase": phase,
        "ok": bool(ok),
        "reason_code": reason_code,
        "live_state_touched": False,
        "contract_sha256_prefix": CONTRACT_SHA256_PREFIX,
    }
    value.update(fields)
    return value


def rejection_receipt(reason_code: str) -> dict[str, Any]:
    """Build the receipt returned when a request is refused.

    The step is not advanced and no authority is granted, whatever the reason.

    Args:
        reason_code: The bounded code explaining the refusal.

    Returns:
        A receipt with phase ``rejected`` and ``ok`` False.
    """
    return _receipt(
        "rejected",
        False,
        reason_code,
        step_advanced=False,
        authority_granted=False,
    )
