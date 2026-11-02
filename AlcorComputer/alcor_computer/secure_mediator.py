"""Hardened mediator: a pinned readiness gate, a strict replay ledger and sanitised reason codes.

This layer wraps the contract core in ``_mediator_core`` so that runtime configuration cannot
grant itself the read-scope prerequisite, and so that a truncated replay file cannot make the
mediator forget a proposal it already consumed.

* ``ReplayLedger`` is the durable, hash-only, consume-once store. Any file that is empty,
  truncated, duplicated or unsorted is rejected instead of being repaired.
* ``ComputerUseMediator.for_repo`` reads a checked-in *pin*
  (``contracts/alcor_read_scope_binding_v1.json``) that must equal the live authority contract
  prefix. The verifier is the in-process authority registry; neither an environment variable
  nor a file of hashes can substitute for it.
* Every receipt's reason code is checked against a fixed list, so an exception message or a
  piece of payload can never be echoed back.
"""

from __future__ import annotations

import os
import re
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from ._mediator_core import (
    ComputerUseMediator as _CoreComputerUseMediator,
)
from ._mediator_core import (
    ContractError,
    ReadChainVerifier,
    ReplayStoreError,
    ValidatedPair,
    parse_json_object,
)
from .contracts import (
    READ_SCOPE_BINDING_SCHEMA,
    UNION_SCHEMA_SHA256_PREFIX,
)
from .readlane_adapter import (
    READ_SCOPE_CONTRACT_SHA256_PREFIX,
    verify_authenticated_read_chain,
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PREFIX_RE = re.compile(r"^[0-9a-f]{12}$")
_BINDING_FIELDS = frozenset({"schema", "contract_sha256_prefix", "frozen", "independently_green"})
_REASON_CODES = frozenset(
    {
        "accepted",
        "staged_no_input",
        "duplicate_key",
        "forged_observe_click",
        "internal_error",
        "invalid_json",
        "invalid_json_number",
        "invalid_json_shape",
        "invalid_shape",
        "invalid_value",
        "mediator_contract_mismatch",
        "missing_field",
        "payload_too_large",
        "projection_failure",
        "read_chain_verifier_unavailable",
        "read_scope_binding_invalid",
        "read_scope_contract_mismatch",
        "read_scope_contract_unavailable",
        "replay",
        "replay_store_busy",
        "replay_store_invalid",
        "replay_store_invalid_key",
        "replay_store_unavailable",
        "scope_not_yet_valid",
        "scope_window_invalid",
        "stale_scope",
        "unknown_field",
    }
)


def _load_binding(root: Path) -> tuple[bool, bool, str | None]:
    """Read the checked-in pin and decide whether it is acceptable.

    The pin must be a closed object whose ``frozen`` and ``independently_green`` flags agree
    with each other and with the presence of a prefix, and whose prefix equals the live
    authority contract prefix.

    Returns:
        ``(binding_valid, frozen_and_green, prefix)``. Any problem returns
        ``(False, False, None)``.
    """
    path = root / "alcor_computer" / "contracts" / "alcor_read_scope_binding_v1.json"
    try:
        binding = parse_json_object(path.read_text(encoding="utf-8"))
    except (OSError, ContractError):
        return False, False, None
    if frozenset(binding) != _BINDING_FIELDS:
        return False, False, None
    if binding["schema"] != READ_SCOPE_BINDING_SCHEMA:
        return False, False, None
    frozen = binding["frozen"]
    independently_green = binding["independently_green"]
    if type(frozen) is not bool or type(independently_green) is not bool:
        return False, False, None
    prefix_value = binding["contract_sha256_prefix"]
    if prefix_value is None:
        prefix = None
    elif isinstance(prefix_value, str) and _PREFIX_RE.fullmatch(prefix_value):
        prefix = prefix_value
    else:
        return False, False, None
    if frozen != independently_green:
        return False, False, None
    if frozen != (prefix is not None):
        return False, False, None
    if prefix is not None and prefix != READ_SCOPE_CONTRACT_SHA256_PREFIX:
        return False, False, None
    return True, frozen and independently_green, prefix


class ReplayLedger:
    """Durable, hash-only, consume-once ledger. Truncation is rejection, not repair.

    With no path the ledger lives in memory (tests and demos). With a path it is a text file of
    sorted, unique, lowercase SHA-256 hex lines. An ``O_EXCL`` lock file serialises writers; the
    whole ledger is rewritten through an fsynced temporary file and an atomic replace, so a torn
    write leaves either the old file or the new one, and a damaged file is refused on the next
    read rather than silently losing a consumed entry.

    Args:
        path: Ledger file, or None for an in-memory ledger.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self._memory: set[str] = set()

    def _read(self) -> set[str]:
        if self.path is None or not self.path.exists():
            return set(self._memory)
        try:
            raw = self.path.read_text(encoding="ascii")
        except OSError as exc:
            raise ReplayStoreError("replay_store_unavailable") from exc
        if not raw or not raw.endswith("\n"):
            raise ReplayStoreError("replay_store_invalid")
        lines = raw.splitlines()
        values: set[str] = set()
        for line in lines:
            if line.strip() != line or _SHA256_RE.fullmatch(line) is None or line in values:
                raise ReplayStoreError("replay_store_invalid")
            values.add(line)
        if lines != sorted(lines):
            raise ReplayStoreError("replay_store_invalid")
        return values

    def consume(self, value: str) -> bool:
        """Record ``value`` (a SHA-256 hex string) and report whether it was new.

        Returns:
            True the first time, False if the value was already consumed.

        Raises:
            ReplayStoreError: ``replay_store_invalid_key``, ``replay_store_busy`` (another writer
                holds the lock), ``replay_store_invalid`` (damaged ledger) or
                ``replay_store_unavailable`` (I/O failure).
        """
        if _SHA256_RE.fullmatch(value) is None:
            raise ReplayStoreError("replay_store_invalid_key")
        if self.path is None:
            if value in self._memory:
                return False
            self._memory.add(value)
            return True

        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_name(self.path.name + ".lock")
        try:
            lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise ReplayStoreError("replay_store_busy") from exc
        try:
            os.close(lock_fd)
            values = self._read()
            if value in values:
                return False
            values.add(value)
            fd, temporary_name = tempfile.mkstemp(prefix=self.path.name + ".", dir=self.path.parent)
            temporary_path = Path(temporary_name)
            try:
                with os.fdopen(fd, "w", encoding="ascii", newline="\n") as handle:
                    for item in sorted(values):
                        handle.write(item + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary_path, self.path)
                if os.name != "nt":
                    # Make the rename itself durable; Windows has no directory fsync.
                    directory_fd = os.open(self.path.parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
            finally:
                temporary_path.unlink(missing_ok=True)
            return True
        except ReplayStoreError:
            raise
        except OSError as exc:
            raise ReplayStoreError("replay_store_unavailable") from exc
        finally:
            lock_path.unlink(missing_ok=True)


class ComputerUseMediator(_CoreComputerUseMediator):
    """Mediator with an immutable, reviewed readiness gate.

    Args:
        read_scope_contract_sha256_prefix: Authority contract prefix, or None.
        read_chain_verifier: Callable that says whether the authority lane produced a chain.
        read_scope_binding_valid: Whether the checked-in pin was found and acceptable.
        read_scope_contract_frozen_green: Whether the pin says the contract is frozen and
            independently verified. Anything other than the literal True counts as False.
        replay_ledger: Consumed-proposal store; an in-memory ledger if omitted.
        now_ms: Clock in epoch milliseconds.
    """

    def __init__(
        self,
        *,
        read_scope_contract_sha256_prefix: str | None,
        read_chain_verifier: ReadChainVerifier | None,
        read_scope_binding_valid: bool = True,
        read_scope_contract_frozen_green: bool = False,
        replay_ledger: ReplayLedger | None = None,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        super().__init__(
            read_scope_contract_sha256_prefix=read_scope_contract_sha256_prefix,
            read_chain_verifier=read_chain_verifier,
            replay_ledger=replay_ledger or ReplayLedger(),
            now_ms=now_ms,
        )
        self.read_scope_binding_valid = read_scope_binding_valid is True
        self.read_scope_contract_frozen_green = read_scope_contract_frozen_green is True

    @classmethod
    def for_repo(
        cls, root: Path, *, replay_ledger: ReplayLedger | None = None
    ) -> ComputerUseMediator:
        """Build a mediator whose readiness comes only from the checked-in pin.

        The verifier is installed only if the pin is valid, frozen, green and equal to the live
        authority prefix. Nothing in the environment or on disk besides the pin is consulted.

        Args:
            root: Directory that contains ``alcor_computer/contracts/``. A directory without
                the pin yields a mediator that refuses everything.
            replay_ledger: Ledger to use. By default a file under
                ``<root>/.local-state/alcor-computer/``.

        Returns:
            The mediator.
        """
        binding_valid, frozen_green, scope_prefix = _load_binding(root)
        source_wired = (
            binding_valid and frozen_green and scope_prefix == READ_SCOPE_CONTRACT_SHA256_PREFIX
        )
        if replay_ledger is None:
            replay_ledger = ReplayLedger(
                root / ".local-state" / "alcor-computer" / "consumed-bundles-v1.txt"
            )
        return cls(
            read_scope_contract_sha256_prefix=scope_prefix,
            read_chain_verifier=verify_authenticated_read_chain if source_wired else None,
            read_scope_binding_valid=binding_valid,
            read_scope_contract_frozen_green=source_wired,
            replay_ledger=replay_ledger,
        )

    def status(self) -> dict[str, Any]:
        """Core status plus the readiness-gate flags; ``validation_ready`` needs all of them."""
        status = super().status()
        registry_ready = self.read_chain_verifier is not None
        validation_ready = (
            self.read_scope_binding_valid
            and self.read_scope_contract_frozen_green
            and self.read_scope_contract_sha256_prefix is not None
            and registry_ready
        )
        status.update(
            {
                "read_scope_binding_valid": self.read_scope_binding_valid,
                "read_scope_contract_frozen_green": self.read_scope_contract_frozen_green,
                "read_scope_verifier_available": registry_ready,
                "validation_ready": validation_ready,
            }
        )
        return status

    def _receipt(
        self,
        *,
        ok: bool,
        reason_code: str,
        staged: bool = False,
        replay_recorded: bool = False,
        read_chain_sha256: str | None = None,
    ) -> dict[str, Any]:
        # An unknown code (an exception message, say) is replaced, never echoed.
        sanitized = reason_code if reason_code in _REASON_CODES else "internal_error"
        receipt = super()._receipt(
            ok=ok,
            reason_code=sanitized,
            staged=staged,
            replay_recorded=replay_recorded,
            read_chain_sha256=read_chain_sha256,
        )
        receipt["reason_code"] = sanitized
        receipt["union_schema_sha256_prefix"] = UNION_SCHEMA_SHA256_PREFIX
        return receipt

    def _validate_read_chain(self, value: Any) -> tuple[Mapping[str, Any], str]:
        if not self.read_scope_binding_valid:
            raise ContractError("read_scope_binding_invalid")
        if not self.read_scope_contract_frozen_green:
            raise ContractError("read_scope_contract_unavailable")
        return super()._validate_read_chain(value)


__all__ = [
    "READ_SCOPE_CONTRACT_SHA256_PREFIX",
    "ComputerUseMediator",
    "ContractError",
    "ReplayLedger",
    "ReplayStoreError",
    "ValidatedPair",
]
