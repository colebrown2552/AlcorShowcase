"""MCP entry point for the computer-use mediator.

Exposes three tools and one resource, and nothing else:

* ``computer_status``: contracts, readiness and the no-input boundary;
* ``computer_validate``: check a read-chain and a click bundle without consuming them;
* ``computer_stage``: check them and consume the proposal once, returning a sanitised receipt.

None of the tools can click, type or contact anything. "Stage" means "record that this exact
proposal was accepted and hand a receipt to whatever gated broker sits downstream".

The server needs the optional ``mcp`` package. Without it, ``python -m alcor_computer.mcp_server``
prints how to install it and exits with status 2.

Environment (all optional):
    ALCOR_COMPUTER_ROOT: directory containing ``alcor_computer/contracts/``
        (default: the checkout this file is in).
    ALCOR_COMPUTER_STATE_DIR: where the consumed-proposal ledger lives
        (default ``~/.alcor/computer``).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from ._mcp_sdk import load_server_class
from .mediator import ComputerUseMediator, ReplayLedger

SERVER_NAME = "AlcorComputer"
TOOLS = ("computer_status", "computer_validate", "computer_stage")
STATUS_RESOURCE = "alcor-computer://status"


def _mcp_server_class() -> Any:
    return load_server_class()


def default_root() -> Path:
    """Return the directory that holds ``alcor_computer/contracts/`` (the mediator's pin)."""
    configured = os.environ.get("ALCOR_COMPUTER_ROOT")
    return Path(configured) if configured else Path(__file__).resolve().parents[1]


def default_state_dir() -> Path:
    """Return the directory for the consumed-proposal ledger."""
    configured = os.environ.get("ALCOR_COMPUTER_STATE_DIR")
    return Path(configured) if configured else Path.home() / ".alcor" / "computer"


def build_server(
    *,
    root: Path | str | None = None,
    computer_mediator: ComputerUseMediator | None = None,
) -> Any:
    """Build the MCP server object (usable over stdio or with the SDK's in-memory client).

    Args:
        root: Directory containing ``alcor_computer/contracts/``; see ``default_root``.
        computer_mediator: A ready mediator, mainly for tests. By default one is built from the
            pin under ``root`` with a ledger in ``default_state_dir()``.

    Returns:
        The SDK server with the three tools and the status resource registered.

    Raises:
        RuntimeError: If the MCP SDK is not installed.
    """
    server_class = _mcp_server_class()
    mcp = server_class(SERVER_NAME)
    mediator = computer_mediator or ComputerUseMediator.for_repo(
        Path(root) if root is not None else default_root(),
        replay_ledger=ReplayLedger(default_state_dir() / "consumed-bundles-v1.txt"),
    )

    @mcp.tool()
    def computer_status() -> dict[str, Any]:
        """Report the AlcorComputer contract, precondition, and no-input boundary."""
        return mediator.status()

    @mcp.tool()
    def computer_validate(read_chain_json: str, computer_bundle_json: str) -> dict[str, Any]:
        """Validate untrusted read-chain and computer-bundle JSON without consuming it.

        The typed mediator decides. This tool cannot click, type or call a model.
        """
        return mediator.validate_json_pair(read_chain_json, computer_bundle_json)

    @mcp.tool()
    def computer_stage(read_chain_json: str, computer_bundle_json: str) -> dict[str, Any]:
        """Consume a valid bundle once and return a sanitised no-input receipt.

        Staging records replay state before any downstream broker handoff. No desktop action is
        implemented or reachable from this tool.
        """
        return mediator.stage_json_pair(read_chain_json, computer_bundle_json)

    @mcp.resource(STATUS_RESOURCE)
    def computer_status_resource() -> str:
        """Machine-readable mediator status."""
        return json.dumps(mediator.status(), indent=2, sort_keys=True)

    return mcp


def server_config() -> dict[str, Any]:
    """Return an MCP client configuration entry that launches this server over stdio."""
    return {
        "mcpServers": {
            "alcor-computer": {
                "command": "python",
                "args": ["-m", "alcor_computer.mcp_server"],
            }
        }
    }


def main(argv: list[str] | None = None) -> int:
    """Run the server, or with ``--check`` / ``--config`` print and exit.

    Returns:
        0 on success, 2 if the MCP SDK is missing or the server cannot be built.
    """
    parser = argparse.ArgumentParser(prog="alcor-computer-mcp", description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="build the server, list tools, exit")
    parser.add_argument("--config", action="store_true", help="print a client configuration, exit")
    args = parser.parse_args(argv)
    if args.config:
        print(json.dumps(server_config(), indent=2, sort_keys=True))
        return 0
    try:
        server = build_server()
    except RuntimeError as exc:
        print(f"alcor-computer-mcp: {exc}", file=sys.stderr)
        return 2
    if args.check:
        print(json.dumps({"ok": True, "server": SERVER_NAME, "tools": list(TOOLS)}, indent=2))
        return 0
    # The protocol owns stdout while serving over stdio; all diagnostics stay on stderr.
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
