"""The click MCP server registers exactly its nine tools and the status resource."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from alcor_click.mcp_server import build_server


class FakeMCP:
    def __init__(self, name: str) -> None:
        self.name = name
        self.tools: dict[str, object] = {}
        self.resources: dict[str, object] = {}

    def tool(self):
        def register(function):
            self.tools[function.__name__] = function
            return function

        return register

    def resource(self, uri: str):
        def register(function):
            self.resources[uri] = function
            return function

        return register


class MCPTests(unittest.TestCase):
    def test_registers_exact_effect_tools(self) -> None:
        with patch("alcor_click.mcp_server._mcp_server_class", return_value=FakeMCP):
            server = build_server(controller=object())
        self.assertEqual(
            set(server.tools),
            {
                "get_window",
                "focus",
                "key",
                "type_text",
                "browser_point",
                "click_browser",
                "click",
                "image_point",
                "click_image",
            },
        )
        self.assertIn("alcor-click://status", server.resources)


if __name__ == "__main__":
    unittest.main()
