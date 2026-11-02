"""Shared fixtures for the authority tests: one authority, one scope, one valid chain request."""

from __future__ import annotations

from alcor_computer.authority import (
    OPERATOR_OUTPUT_SCHEMA,
    TASK_INPUT_SCHEMA,
    FakeObservationAdapter,
    ReadLane,
    ReadLaneAuthority,
    SingleTurnStubOperator,
)


def authority() -> ReadLaneAuthority:
    return ReadLaneAuthority.source_bound()


def scope(auth: ReadLaneAuthority):
    return auth.issue_scope(
        ["src/*"],
        ["search", "read"],
        max_results=3,
        max_bytes=64,
    )


def task(task_name: str = "read-chain", tool_access: bool = True, source: str = "bounded source"):
    return {
        "schema": TASK_INPUT_SCHEMA,
        "task": task_name,
        "tool_access": tool_access,
        "source": source,
    }


def valid_operator_output():
    return {
        "schema": OPERATOR_OUTPUT_SCHEMA,
        "actions": [
            {
                "verb": "search",
                "path": "src/readlane.py",
                "query": "typed",
                "max_results": 2,
                "max_bytes": 48,
            },
            {
                "verb": "read",
                "path": "src/readlane.py",
                "query": None,
                "max_results": 1,
                "max_bytes": 48,
            },
        ],
        "requested_scope": None,
        "authority_granted": False,
        "step_completed": False,
        "canonical_state_mutated": False,
    }


def adapter():
    return FakeObservationAdapter(
        {
            "src/readlane.py": "typed code validates observations " * 8,
            "src/other.py": "typed auxiliary document",
        }
    )


def run_with_output(output):
    auth = authority()
    operator = SingleTurnStubOperator(output)
    result = ReadLane(auth).run(task(), scope(auth), operator, adapter())
    return auth, operator, result
