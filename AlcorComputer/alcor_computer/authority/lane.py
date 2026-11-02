"""The read lane: a typed state machine for one search-then-read chain.

Typed code, not the model, drives every step. The operator is called once, its answer is
validated, and then ``prepared -> search -> read -> completed`` is produced in that order. A
failure at any point yields a single rejection receipt and no result, so a partial chain can
never be mistaken for a complete one.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping

from ..contracts import sha256_hex
from .contract import (
    HASH_PREFIX_LENGTH,
    READ_CHAIN_PHASES,
    AuthorityError,
    _receipt,
    rejection_receipt,
)
from .issuer import ReadLaneAuthority
from .observation import adapt_read, adapt_search
from .operator_checks import validate_read_operator_output, validate_task_input
from .values import LaneRun, ObservationAdapter, ReadScopeToken


class ReadLane:
    """Runs one authenticated ``prepared -> search -> read -> completed`` chain.

    Args:
        authority: The authority that validates scope tokens and signs the finished chain.
    """

    def __init__(self, authority: ReadLaneAuthority) -> None:
        self.authority = authority

    def run(
        self,
        task_input: Mapping[str, object],
        token: ReadScopeToken,
        operator: Callable[[Mapping[str, object]], Mapping[str, object]],
        adapter: ObservationAdapter,
    ) -> LaneRun:
        """Run the chain once.

        Order of events: validate the task, validate the scope token, call the operator exactly
        once, validate its answer, then call the adapter for ``search`` and for ``read``. The
        adapter is never reached for a request that failed validation.

        Args:
            task_input: The task record (``read-chain`` kind, tools enabled).
            token: The scope the operator is allowed to use.
            operator: A callable that returns the operator's output for ``task_input``.
            adapter: The data source behind ``search`` and ``read``.

        Returns:
            ``LaneRun(ok=True, ...)`` with four ordered receipts and an authenticated result, or
            ``LaneRun(ok=False, ...)`` with a single rejection receipt. This method does not
            raise: unexpected errors become the ``internal_error`` reason code.
        """
        try:
            validate_task_input(task_input, "read-chain", True)
            validated_token = self.authority.validate_scope(token)
            operator_output = operator(task_input)
            actions = validate_read_operator_output(operator_output, validated_token)
            prepared = _receipt(
                "prepared",
                True,
                "prepared",
                scope_authenticated=True,
                path_glob_count=len(validated_token.path_globs),
                verb_count=len(validated_token.verbs),
                operator_turns=1,
            )
            search_observation = adapt_search(adapter, actions[0])
            search_receipt = _receipt(
                "search",
                True,
                "validated_observation",
                **search_observation.receipt_fields(),
            )
            read_observation = adapt_read(adapter, actions[1])
            read_receipt = _receipt(
                "read",
                True,
                "validated_observation",
                **read_observation.receipt_fields(),
            )
            prior = (prepared, search_receipt, read_receipt)
            # The last receipt commits to the three before it, so dropping or reordering any of
            # them changes this hash and fails verification.
            completed = _receipt(
                "completed",
                True,
                "typed_code_completed",
                typed_code_completed=True,
                operator_completed_step=False,
                receipt_count=len(READ_CHAIN_PHASES),
                chain_sha256_prefix=sha256_hex(list(prior))[:HASH_PREFIX_LENGTH],
            )
            receipts = (*prior, completed)
            result = self.authority.authorize_result(
                validated_token,
                receipts,
                (search_observation, read_observation),
            )
            return LaneRun(True, receipts, result)
        except AuthorityError as exc:
            receipt = rejection_receipt(exc.reason_code)
            return LaneRun(False, (receipt,), None)
        except Exception:
            receipt = rejection_receipt("internal_error")
            return LaneRun(False, (receipt,), None)
