"""The MCP server registers exactly the mediator tools, with or without the optional SDK."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from alcor_computer.mcp_server import build_server


class FakeMCP:
    """Small decorator-compatible stand-in for the MCP server class, for registration-only tests."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.tools: dict[str, object] = {}
        self.prompts: dict[str, object] = {}
        self.resources: dict[str, object] = {}

    def tool(self):
        def register(function):
            self.tools[function.__name__] = function
            return function

        return register

    def prompt(self):
        def register(function):
            self.prompts[function.__name__] = function
            return function

        return register

    def resource(self, uri: str):
        def register(function):
            self.resources[uri] = function
            return function

        return register


class MCPRegistrationTests(unittest.TestCase):
    def test_computer_tools_register_without_optional_sdk(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("alcor_computer.mcp_server._mcp_server_class", return_value=FakeMCP):
                server = build_server(root=root)

        self.assertEqual(
            set(server.tools), {"computer_status", "computer_validate", "computer_stage"}
        )
        self.assertIn("alcor-computer://status", server.resources)

        status = server.tools["computer_status"]()
        self.assertFalse(status["validation_ready"])
        self.assertFalse(status["owner_gated_input_reachable"])


if __name__ == "__main__":
    unittest.main()
