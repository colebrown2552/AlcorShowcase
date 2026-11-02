"""Shared fixtures: a policy host backed by the sibling alcorlang package, and a scratch scope."""

from __future__ import annotations

import pytest

from alcorcli.config import Scope
from alcorcli.errors import PolicyError
from alcorcli.policy import PolicyHost
from alcorcli.receipts import ReceiptLog


@pytest.fixture(scope="session")
def policy() -> PolicyHost:
    """A policy host. The tests that consult a program need the sibling interpreter."""
    host = PolicyHost()
    try:
        host.runtime()
    except PolicyError as exc:
        pytest.skip(f"the sibling alcorlang package is not importable: {exc.detail}")
    return host


@pytest.fixture()
def workspace(tmp_path):
    """An empty directory that stands in for the workspace."""
    root = tmp_path / "work"
    root.mkdir()
    return root


@pytest.fixture()
def scope(workspace) -> Scope:
    """A scope whose only root is the scratch workspace."""
    return Scope.for_workspace(workspace, environ={})


@pytest.fixture()
def receipts(tmp_path) -> ReceiptLog:
    """An empty receipt log with a fixed clock."""
    return ReceiptLog(tmp_path / "state" / "receipts.jsonl", clock=lambda: 1_700_000_000.0)
