"""The public mediator: the hardened mediator with every failure bounded into a receipt.

``ComputerUseMediator`` here is the class applications and the MCP server use. It subclasses the
hardened mediator in ``secure_mediator`` (which subclasses the contract core in
``_mediator_core``) and adds three things:

* a malformed-Unicode or unexpected parser failure becomes an ``invalid_json`` or
  ``internal_error`` receipt instead of an exception;
* a replay-store I/O failure becomes ``replay_store_unavailable``, with no path in the receipt;
* a missing or wrong pin is reported as ``read_scope_contract_unavailable``, the reason a caller
  without access to the pin file would expect.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from ._mediator_core import (
    ContractError,
    ReadChainVerifier,
    ReplayStoreError,
    ValidatedPair,
    parse_json_object,
)
from .secure_mediator import ComputerUseMediator as _HardenedComputerUseMediator
from .secure_mediator import ReplayLedger


class ComputerUseMediator(_HardenedComputerUseMediator):
    """Mediator that never raises for bad input; it returns a sanitised receipt.

    Args:
        read_scope_contract_sha256_prefix: Authority contract prefix, or None.
        read_chain_verifier: Callable that says whether the authority lane produced a chain.
        read_scope_binding_valid: Whether the checked-in pin was acceptable.
        read_scope_contract_frozen_green: Whether the pin is frozen and independently verified.
            When omitted, the gate counts as green exactly when a verifier is supplied, which is
            convenient for fixtures that inject a stub verifier. ``for_repo`` always passes the
            flag explicitly.
        replay_ledger: Consumed-proposal store; in memory if omitted.
        now_ms: Clock in epoch milliseconds.
    """

    def __init__(
        self,
        *,
        read_scope_contract_sha256_prefix: str | None,
        read_chain_verifier: ReadChainVerifier | None,
        read_scope_binding_valid: bool = True,
        read_scope_contract_frozen_green: bool | None = None,
        replay_ledger: ReplayLedger | None = None,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        if read_scope_contract_frozen_green is None:
            read_scope_contract_frozen_green = read_chain_verifier is not None
        super().__init__(
            read_scope_contract_sha256_prefix=read_scope_contract_sha256_prefix,
            read_chain_verifier=read_chain_verifier,
            read_scope_binding_valid=read_scope_binding_valid,
            read_scope_contract_frozen_green=read_scope_contract_frozen_green,
            replay_ledger=replay_ledger,
            now_ms=now_ms,
        )

    def validate_json_pair(
        self,
        read_chain_json: str,
        computer_bundle_json: str,
    ) -> dict[str, Any]:
        """Validate two JSON documents without consuming them; always returns a receipt."""
        try:
            return super().validate_json_pair(read_chain_json, computer_bundle_json)
        except UnicodeError:
            return self.reject_receipt("invalid_json")
        except Exception:
            return self.reject_receipt("internal_error")

    def stage_json_pair(
        self,
        read_chain_json: str,
        computer_bundle_json: str,
    ) -> dict[str, Any]:
        """Validate and consume a proposal once; always returns a receipt, never a payload."""
        try:
            return super().stage_json_pair(read_chain_json, computer_bundle_json)
        except UnicodeError:
            return self.reject_receipt("invalid_json")
        except OSError:
            return self.reject_receipt("replay_store_unavailable")
        except Exception:
            return self.reject_receipt("internal_error")

    def _validate_read_chain(self, value: Any) -> tuple[Mapping[str, Any], str]:
        try:
            return super()._validate_read_chain(value)
        except ContractError as exc:
            if exc.reason_code == "read_scope_binding_invalid":
                raise ContractError("read_scope_contract_unavailable") from exc
            raise


__all__ = [
    "ComputerUseMediator",
    "ContractError",
    "ReplayLedger",
    "ReplayStoreError",
    "ValidatedPair",
    "parse_json_object",
]
