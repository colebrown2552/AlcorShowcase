"""Exercise the AlcorDesign MCP stdio adapter against a fake local server.

Usage:

    python tests/mcp_acceptance.py --exe PATH_TO_ALCOR_DESIGN [--live]

Fixture mode starts a temporary loopback HTTP server (OS-assigned port) and a
synthetic runtime.json, so no real project is touched. With --live the adapter
is also pointed at the default runtime of an already running AlcorDesign server
and reads design_status and design_list_projects from it.
"""

import argparse
import base64
import json
import os
import subprocess
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def request(ident, method, params=None):
    value = {"jsonrpc": "2.0", "id": ident, "method": method}
    if params is not None:
        value["params"] = params
    return value


INIT = request(
    1,
    "initialize",
    {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "AlcorDesign acceptance", "version": "1"},
    },
)


def exchange(exe, messages, runtime=None):
    env = os.environ.copy()
    if runtime is not None:
        env["ALCORDESIGN_RUNTIME"] = str(runtime)
    raw = "\n".join(json.dumps(x) if not isinstance(x, str) else x for x in messages) + "\n"
    result = subprocess.run(
        [str(exe), "mcp"],
        input=raw,
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        timeout=45,
    )
    assert result.returncode == 0, f"MCP process exit {result.returncode}: {result.stderr[:200]}"
    outputs = [json.loads(line) for line in result.stdout.splitlines()]
    assert all(x.get("jsonrpc") == "2.0" for x in outputs), "non-protocol stdout"
    return outputs, result.stdout, result.stderr


class Fixture(BaseHTTPRequestHandler):
    requests = []
    token = uuid.uuid4().hex

    def log_message(self, *args):
        pass

    def do_POST(self):
        assert self.path == "/api/tools"
        assert self.headers.get("Authorization") == "Bearer " + self.token
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        name = body["name"]
        if name == "design_get_project":
            self.send_response(404)
            value = {"error": "Project not found"}
        elif name == "design_read_source":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1/not-followed")
            value = {"error": "fixture redirect"}
        elif name == "design_get_screenshot":
            self.send_response(200)
            value = {
                "url": "/files/projects/test.png"
                if body["arguments"]["page_id"] == "valid"
                else "http://127.0.0.1/invalid.png",
                "width": 1,
                "height": 1,
                "mimeType": "image/png",
            }
        else:
            self.send_response(200)
            value = {"ok": True, "tool": name, "arguments": body["arguments"]}
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())

    def do_GET(self):
        assert self.path == "/files/projects/test.png"
        assert self.headers.get("Authorization") == "Bearer " + self.token
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.end_headers()
        self.wfile.write(
            base64.b64decode(
                "iVBORw0KGgoAAAAN"
                "SUhEUgAAAAEAAAAB"
                "CAQAAAC1HAwCAAAA"
                "C0lEQVR42mP8/x8A"
                "AwMCAO5+/W8AAAAA"
                "SUVORK5CYII="
            )
        )


def run(exe, live=False):
    passed = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="alcordesign-mcp-") as folder:
            runtime = Path(folder) / "runtime.json"
            runtime.write_text(
                json.dumps({"port": server.server_port, "token": Fixture.token}), encoding="utf-8"
            )
            messages = [
                request(0, "tools/list"),
                INIT,
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                request(2, "tools/list"),
                request(3, "tools/call", {"name": "design_status", "arguments": {}}),
                request(
                    4,
                    "tools/call",
                    {
                        "name": "design_render_page",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "width": "1440",
                            "height": 900,
                        },
                    },
                ),
                request(
                    5,
                    "tools/call",
                    {"name": "design_status", "arguments": {"url": "http://invalid"}},
                ),
                request(6, "tools/call", {"name": "unknown", "arguments": {}}),
                request(
                    7,
                    "tools/call",
                    {"name": "design_get_project", "arguments": {"project_id": "missing"}},
                ),
                request(
                    8,
                    "tools/call",
                    {"name": "design_read_source", "arguments": {"path": "README.md"}},
                ),
                request(
                    9,
                    "tools/call",
                    {
                        "name": "design_update_node",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "expected_revision": 1,
                            "selector": "h1",
                            "text": "A real local edit",
                            "styles": {"color": "#12abcd"},
                        },
                    },
                ),
                request(
                    10,
                    "tools/call",
                    {
                        "name": "design_update_node",
                        "arguments": {"project_id": "p", "page_id": "x", "selector": "h1"},
                    },
                ),
                "{invalid json",
                request(11, "ping"),
                request(
                    13,
                    "tools/call",
                    {
                        "name": "design_get_screenshot",
                        "arguments": {"project_id": "p", "page_id": "valid"},
                    },
                ),
                request(
                    14,
                    "tools/call",
                    {
                        "name": "design_get_screenshot",
                        "arguments": {"project_id": "p", "page_id": "invalid"},
                    },
                ),
                request(
                    15,
                    "tools/call",
                    {
                        "name": "design_add_comment",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "x": 0.5,
                            "y": 120,
                            "body": "Adjust this heading",
                            "author": "Fixture",
                        },
                    },
                ),
                request(
                    16,
                    "tools/call",
                    {
                        "name": "design_resolve_comment",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "comment_id": "c",
                            "resolved": "yes",
                        },
                    },
                ),
                request(
                    17,
                    "tools/call",
                    {
                        "name": "design_resolve_comment",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "comment_id": "c",
                            "resolved": False,
                        },
                    },
                ),
                request(
                    18,
                    "tools/call",
                    {
                        "name": "design_add_comment",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "x": -1,
                            "y": 120,
                            "body": "Invalid negative coordinate",
                        },
                    },
                ),
                request(
                    19,
                    "tools/call",
                    {
                        "name": "design_index",
                        "arguments": {"project_id": "p", "query": "hero", "offset": 2, "limit": 5},
                    },
                ),
                request(
                    20,
                    "tools/call",
                    {
                        "name": "design_page_tree",
                        "arguments": {"project_id": "p", "page_id": "x", "limit": 201},
                    },
                ),
                request(
                    21,
                    "tools/call",
                    {
                        "name": "design_page_tree",
                        "arguments": {"project_id": "p", "page_id": "x", "depth": 2},
                    },
                ),
                request(
                    22,
                    "tools/call",
                    {
                        "name": "design_page_sources",
                        "arguments": {"project_id": "p", "page_id": "x"},
                    },
                ),
                request(
                    23,
                    "tools/call",
                    {
                        "name": "design_sync_sitemap",
                        "arguments": {"project_id": "p", "max_pages": 501},
                    },
                ),
                request(
                    24,
                    "tools/call",
                    {
                        "name": "design_source_draft",
                        "arguments": {"project_id": "p", "path": "site/style.css"},
                    },
                ),
                request(
                    25,
                    "tools/call",
                    {
                        "name": "design_save_source",
                        "arguments": {
                            "project_id": "p",
                            "path": "site/style.css",
                            "content": "",
                            "expected_version": "v1",
                            "request_id": "fixture-save-1",
                        },
                    },
                ),
                request(
                    26,
                    "tools/call",
                    {
                        "name": "design_save_source",
                        "arguments": {
                            "project_id": "p",
                            "path": "site/style.css",
                            "content": "changed",
                        },
                    },
                ),
                request(
                    27,
                    "tools/call",
                    {
                        "name": "design_sync_sources",
                        "arguments": {
                            "project_id": "p",
                            "request_id": "fixture-sync-1",
                            "draft_set_version": "a" * 64,
                            "force": True,
                        },
                    },
                ),
                request(
                    29,
                    "tools/call",
                    {"name": "design_sync_sources", "arguments": {"project_id": "p"}},
                ),
                request(
                    28,
                    "tools/call",
                    {
                        "name": "design_source_files",
                        "arguments": {"project_id": "p", "query": ".css"},
                    },
                ),
                request(
                    30,
                    "tools/call",
                    {
                        "name": "design_source_operation_status",
                        "arguments": {"project_id": "p", "request_id": "fixture-sync-1"},
                    },
                ),
                request(
                    31,
                    "tools/call",
                    {
                        "name": "design_refresh_live_page",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "request_id": "fixture-refresh-1",
                            "expected_revision": 3,
                            "keep_snapshot": True,
                        },
                    },
                ),
                request(
                    32,
                    "tools/call",
                    {
                        "name": "design_refresh_live_page",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "request_id": "fixture-refresh-1",
                        },
                    },
                ),
                request(
                    33,
                    "tools/call",
                    {
                        "name": "design_restore_page_snapshot",
                        "arguments": {
                            "project_id": "p",
                            "page_id": "x",
                            "snapshot_id": "s",
                            "request_id": "fixture-restore-1",
                            "expected_revision": "3",
                        },
                    },
                ),
            ]
            output, stdout, stderr = exchange(exe, messages, runtime)
            rows = {row.get("id"): row for row in output}
            assert len(output) == len(messages) - 1, "notification produced a response"
            assert rows[0]["error"]["code"] == -32002
            assert rows[1]["result"]["protocolVersion"] == "2025-06-18"
            passed.append("initialize and notification lifecycle")
            catalog = rows[2]["result"]["tools"]
            names = [x["name"] for x in catalog]
            assert len(names) == 42 and len(set(names)) == 42
            assert all(x["inputSchema"]["additionalProperties"] is False for x in catalog)
            passed.append("42 discoverable typed tools")
            assert rows[3]["result"]["structuredContent"]["ok"] is True
            assert (
                rows[9]["result"]["structuredContent"]["arguments"]["text"] == "A real local edit"
            )
            passed.append("authenticated read and edit forwarding")
            assert all(rows[n]["result"]["isError"] for n in [4, 5, 10])
            assert rows[6]["error"]["code"] == -32602
            assert len(Fixture.requests) == 16
            passed.append("invalid arguments rejected before HTTP dispatch")
            assert rows[7]["result"]["isError"] and "404" in rows[7]["result"]["content"][0]["text"]
            assert rows[8]["result"]["isError"] and "302" in rows[8]["result"]["content"][0]["text"]
            assert len(Fixture.requests) == 16
            passed.append("errors surfaced with no redirects or retries")
            assert rows[None]["error"]["code"] == -32700 and rows[11]["result"] == {}
            assert Fixture.token not in stdout + stderr
            passed.append("parse-error recovery and no token exposure")
            image = rows[13]["result"]["content"][1]
            assert image["type"] == "image" and image["mimeType"] == "image/png"
            assert base64.b64decode(image["data"]).startswith(b"\x89PNG\r\n\x1a\n")
            assert rows[14]["result"]["isError"] is True
            passed.append("native PNG image content with local-path confinement")
            assert rows[15]["result"]["structuredContent"]["arguments"]["x"] == 0.5
            assert rows[17]["result"]["structuredContent"]["arguments"]["resolved"] is False
            assert rows[16]["result"]["isError"] and rows[18]["result"]["isError"]
            passed.append("comment coordinate and boolean validation")
            assert rows[19]["result"]["structuredContent"]["arguments"]["offset"] == 2
            assert rows[21]["result"]["structuredContent"]["arguments"]["depth"] == 2
            assert rows[22]["result"]["structuredContent"]["arguments"]["page_id"] == "x"
            assert rows[20]["result"]["isError"] and rows[23]["result"]["isError"]
            assert (
                next(x for x in catalog if x["name"] == "design_sync_sitemap")["annotations"][
                    "readOnlyHint"
                ]
                is False
            )
            passed.append("index, tree, source and sitemap bounds and mutation annotations")
            assert rows[24]["result"]["structuredContent"]["arguments"]["path"] == "site/style.css"
            assert rows[25]["result"]["structuredContent"]["arguments"]["content"] == ""
            assert (
                rows[26]["result"]["isError"]
                and rows[27]["result"]["isError"]
                and rows[29]["result"]["isError"]
            )
            assert rows[28]["result"]["structuredContent"]["arguments"]["query"] == ".css"
            assert (
                rows[30]["result"]["structuredContent"]["arguments"]["request_id"]
                == "fixture-sync-1"
            )
            assert (
                next(x for x in catalog if x["name"] == "design_sync_sources")["annotations"][
                    "readOnlyHint"
                ]
                is False
            )
            passed.append("source draft version validation and explicit sync schema")
            assert rows[31]["result"]["structuredContent"]["arguments"]["keep_snapshot"] is True
            assert rows[32]["result"]["isError"] and rows[33]["result"]["isError"]
            passed.append("live refresh revision, backup, and retry validation")
            oversized = "x" * (8 * 1024 * 1024 + 1)
            output, _, _ = exchange(exe, [oversized, request(12, "ping")], runtime)
            assert output[0]["error"]["code"] == -32600
            assert output[1]["id"] == 12 and output[1]["result"] == {}
            passed.append("oversized frame rejection and next-frame recovery")
            env = os.environ.copy()
            env["ALCORDESIGN_RUNTIME"] = str(runtime)
            once = subprocess.run(
                [str(exe), "call", "design_status", "{}"],
                text=True,
                encoding="utf-8",
                capture_output=True,
                env=env,
                timeout=15,
            )
            assert once.returncode == 0 and json.loads(once.stdout)["ok"] is True
            assert Fixture.token not in once.stdout + once.stderr
            assert len(Fixture.requests) == 17
            passed.append("one-shot authorized process adapter")
        if live:
            output, _, _ = exchange(
                exe,
                [
                    INIT,
                    request(2, "tools/call", {"name": "design_status", "arguments": {}}),
                    request(3, "tools/call", {"name": "design_list_projects", "arguments": {}}),
                ],
            )
            assert output[1]["result"]["isError"] is False, output[1]
            assert output[2]["result"]["isError"] is False, output[2]
            passed.append("running-server status and project inventory over MCP")
        return {"ok": True, "checks": passed, "count": len(passed)}
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True, type=Path)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(args.exe.resolve(), args.live), indent=2))
