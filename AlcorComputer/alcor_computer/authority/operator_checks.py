"""Closed-shape validation of task inputs and of what the operator hands back.

The operator (an LLM, or a stub in tests) is treated as an untrusted source of *data*. Its output
must match a fixed shape, must not ask for more than the scope allows, and must not claim any
authority, completion or state change for itself. Each violation has its own reason code so a
receipt says exactly which rule was hit.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .contract import (
    ALLOWED_VERBS,
    MAX_ACTIONS,
    MAX_QUERY_CHARS,
    MAX_SCOPE_BYTES,
    MAX_SCOPE_RESULTS,
    OPERATOR_OUTPUT_SCHEMA,
    TASK_INPUT_SCHEMA,
    AuthorityError,
    _bounded_int,
    _closed_mapping,
    _exact_bool,
    _normalize_repo_path,
    _path_in_scope,
)
from .values import ReadScopeToken


def validate_task_input(value: Any, expected_task: str, tools_enabled: bool) -> Mapping[str, Any]:
    """Check the task record given to the operator.

    Args:
        value: The task dict.
        expected_task: The task kind this call site runs (``read-chain``, ``summary``,
            ``proposal``).
        tools_enabled: Whether this task kind may use tools. A mismatch is refused, which is how
            a no-tool summary is kept tool-free.

    Returns:
        The validated task.

    Raises:
        AuthorityError: ``invalid_task``, ``tool_access_mismatch`` or ``source_cap_exceeded``.
    """
    task = _closed_mapping(value, ("schema", "task", "tool_access", "source"))
    if task["schema"] != TASK_INPUT_SCHEMA or task["task"] != expected_task:
        raise AuthorityError("invalid_task")
    if _exact_bool(task["tool_access"]) is not tools_enabled:
        raise AuthorityError("tool_access_mismatch")
    if not isinstance(task["source"], str):
        raise AuthorityError("invalid_task")
    if len(task["source"].encode("utf-8")) > MAX_SCOPE_BYTES:
        raise AuthorityError("source_cap_exceeded")
    return task


def reject_authority_claims(output: Mapping[str, Any]) -> None:
    """Refuse operator output that widens scope or claims authority, completion or mutation."""
    if output["requested_scope"] is not None:
        raise AuthorityError("scope_widening_attempt")
    if _exact_bool(output["authority_granted"]):
        raise AuthorityError("authority_grant_attempt")
    if _exact_bool(output["step_completed"]):
        raise AuthorityError("self_completion_attempt")
    if _exact_bool(output["canonical_state_mutated"]):
        raise AuthorityError("canonical_mutation_attempt")


def validate_read_operator_output(
    value: Any,
    token: ReadScopeToken,
) -> tuple[Mapping[str, Any], ...]:
    """Check the operator's two requested actions against the scope token.

    The operator must ask for exactly one ``search`` followed by one ``read``, in that order,
    each inside the token's globs, verbs and caps.

    Args:
        value: The operator output dict.
        token: The validated scope token.

    Returns:
        The two normalised actions, search first.

    Raises:
        AuthorityError: A specific reason code, for example ``verb_not_allowed``,
            ``path_out_of_scope``, ``result_cap_exceeded``, ``byte_cap_exceeded``,
            ``invalid_action_order`` or one of the authority-claim codes.
    """
    output = _closed_mapping(
        value,
        (
            "schema",
            "actions",
            "requested_scope",
            "authority_granted",
            "step_completed",
            "canonical_state_mutated",
        ),
    )
    if output["schema"] != OPERATOR_OUTPUT_SCHEMA:
        raise AuthorityError("invalid_operator_output")
    reject_authority_claims(output)
    actions = output["actions"]
    if not isinstance(actions, list) or len(actions) != MAX_ACTIONS:
        raise AuthorityError("invalid_action_count")
    validated: list[Mapping[str, Any]] = []
    for action_value in actions:
        action = _closed_mapping(
            action_value,
            ("verb", "path", "query", "max_results", "max_bytes"),
        )
        verb = action["verb"]
        if not isinstance(verb, str) or verb not in ALLOWED_VERBS or verb not in token.verbs:
            raise AuthorityError("verb_not_allowed")
        path = _normalize_repo_path(action["path"])
        if not _path_in_scope(path, token.path_globs):
            raise AuthorityError("path_out_of_scope")
        results_cap = _bounded_int(action["max_results"], 1, MAX_SCOPE_RESULTS)
        byte_cap = _bounded_int(action["max_bytes"], 1, MAX_SCOPE_BYTES)
        if results_cap > token.max_results:
            raise AuthorityError("result_cap_exceeded")
        if byte_cap > token.max_bytes:
            raise AuthorityError("byte_cap_exceeded")
        query = action["query"]
        if verb == "search":
            if not isinstance(query, str) or not query or len(query) > MAX_QUERY_CHARS:
                raise AuthorityError("invalid_query")
        elif query is not None or results_cap != 1:
            raise AuthorityError("invalid_read_action")
        validated.append(
            {
                "verb": verb,
                "path": path,
                "query": query,
                "max_results": results_cap,
                "max_bytes": byte_cap,
            }
        )
    if tuple(item["verb"] for item in validated) != ("search", "read"):
        raise AuthorityError("invalid_action_order")
    return tuple(validated)
