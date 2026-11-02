"""Locate the optional MCP SDK and fail with a clear message when it is missing.

Nothing else in this package needs the SDK: the mediator, app control and runtime run on the
standard library alone. Only the two MCP servers (``alcor_computer.mcp_server`` and
``alcor_click.mcp_server``) import it, and only when they are asked to start.
"""

from __future__ import annotations

from typing import Any

MISSING_SDK_MESSAGE = (
    "The MCP SDK is not installed, so the MCP server cannot start. "
    'Install it with: pip install "mcp[cli]"  (everything else in this package works without it).'
)


def load_server_class() -> Any:
    """Return the SDK's server class.

    The 2.x name (``mcp.server.MCPServer``) is tried first and the 1.x name
    (``mcp.server.fastmcp.FastMCP``) second; both accept ``@tool()`` and ``@resource(uri)``
    decorators in the same way.

    Raises:
        RuntimeError: With ``MISSING_SDK_MESSAGE`` if neither can be imported.
    """
    try:
        from mcp.server import MCPServer

        return MCPServer
    except ImportError:
        pass
    try:
        from mcp.server.fastmcp import FastMCP

        return FastMCP
    except ImportError as exc:
        raise RuntimeError(MISSING_SDK_MESSAGE) from exc
