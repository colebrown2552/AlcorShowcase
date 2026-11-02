"""MCP entry point for AlcorClick: observation-bound foreground-window input on Windows.

This server is deliberately separate from the mediator's server (``alcor_computer.mcp_server``),
which can only validate and stage. Here the tools can act, so each one is bounded: they observe
the foreground window, then focus it, press an allowlisted key, type bounded text or left-click,
always against a fresh single-use observation.

The server needs the optional ``mcp`` package. Without it, ``python -m alcor_click.mcp_server``
prints how to install it and exits with status 2.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from alcor_computer._mcp_sdk import load_server_class

from .control import AlcorClickController

SERVER_NAME = "AlcorClick"
TOOLS = (
    "get_window",
    "focus",
    "key",
    "type_text",
    "browser_point",
    "click_browser",
    "click",
    "image_point",
    "click_image",
)
STATUS_RESOURCE = "alcor-click://status"


def _mcp_server_class() -> Any:
    return load_server_class()


def _resolve_object(resolve_json: str) -> Any:
    """Parse the browser ``resolve(ref)`` result passed as a JSON string."""
    try:
        return json.loads(resolve_json)
    except (TypeError, ValueError) as exc:
        raise ValueError("resolve_json must be one JSON object") from exc


def build_server(controller: AlcorClickController | None = None) -> Any:
    """Build the MCP server object with the nine AlcorClick tools and the status resource.

    Args:
        controller: A ready controller (tests inject one with a fake provider). By default a
            Windows controller is created on first use.

    Raises:
        RuntimeError: If the MCP SDK is not installed.
    """
    server_class = _mcp_server_class()
    mcp = server_class(SERVER_NAME)
    state = controller

    def clicker() -> AlcorClickController:
        nonlocal state
        if state is None:
            state = AlcorClickController()
        return state

    @mcp.tool()
    def get_window(screenshot: bool = True) -> dict[str, Any]:
        """Observe the foreground window and return physical screen coordinates."""
        return clicker().get_window(screenshot=screenshot)

    @mcp.tool()
    def focus(hwnd: int) -> dict[str, Any]:
        """Focus one already-running visible window by HWND."""
        return clicker().focus(hwnd)

    @mcp.tool()
    def key(key: str, observation_id: str | None = None) -> dict[str, Any]:
        """Send one allowlisted key chord to the freshly observed foreground window."""
        return clicker().key(key=key, observation_id=observation_id)

    @mcp.tool()
    def type_text(text: str, observation_id: str | None = None) -> dict[str, Any]:
        """Type bounded printable text into the freshly observed foreground window."""
        return clicker().type_text(text=text, observation_id=observation_id)

    @mcp.tool()
    def browser_point(resolve_json: str, observation_id: str | None = None) -> dict[str, Any]:
        """Translate one fresh browser resolve(ref) result into Win32 physical pixels."""
        return clicker().browser_point(_resolve_object(resolve_json), observation_id=observation_id)

    @mcp.tool()
    def click_browser(resolve_json: str, observation_id: str | None = None) -> dict[str, Any]:
        """Translate and click one fresh browser resolve(ref) target."""
        return clicker().click_browser(_resolve_object(resolve_json), observation_id=observation_id)

    @mcp.tool()
    def click(x: int, y: int, observation_id: str | None = None) -> dict[str, Any]:
        """Perform one left click against the fresh foreground-window observation."""
        return clicker().click(x=x, y=y, observation_id=observation_id)

    @mcp.tool()
    def image_point(x: int, y: int, observation_id: str, screenshot_sha256: str) -> dict[str, Any]:
        """Translate image pixels from one observed screenshot to host screen pixels (read only)."""
        return clicker().image_point(x, y, observation_id, screenshot_sha256)

    @mcp.tool()
    def click_image(x: int, y: int, observation_id: str, screenshot_sha256: str) -> dict[str, Any]:
        """Click a screenshot-grounded point only if the scene is unchanged; never auto-retry."""
        return clicker().click_image(x, y, observation_id, screenshot_sha256)

    @mcp.resource(STATUS_RESOURCE)
    def status_resource() -> str:
        """Describe AlcorClick's freshness, platform and effect-path contract."""
        return json.dumps(clicker().status(), indent=2, sort_keys=True)

    return mcp


def server_config() -> dict[str, Any]:
    """Return an MCP client configuration entry that launches this server over stdio."""
    return {
        "mcpServers": {
            "alcor-click": {
                "command": "python",
                "args": ["-m", "alcor_click.mcp_server"],
            }
        }
    }


def main(argv: list[str] | None = None) -> int:
    """Run the server, or with ``--check`` / ``--config`` print and exit.

    Returns:
        0 on success, 2 if the MCP SDK is missing.
    """
    parser = argparse.ArgumentParser(prog="alcor-click-mcp", description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="build the server, list tools, exit")
    parser.add_argument("--config", action="store_true", help="print a client configuration, exit")
    args = parser.parse_args(argv)
    if args.config:
        print(json.dumps(server_config(), indent=2, sort_keys=True))
        return 0
    try:
        server = build_server()
    except RuntimeError as exc:
        print(f"alcor-click-mcp: {exc}", file=sys.stderr)
        return 2
    if args.check:
        print(json.dumps({"ok": True, "server": SERVER_NAME, "tools": list(TOOLS)}, indent=2))
        return 0
    # The protocol owns stdout while serving over stdio; all diagnostics stay on stderr.
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
