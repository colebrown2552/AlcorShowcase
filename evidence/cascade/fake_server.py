#!/usr/bin/env python3
"""Fake chat-completions server on 127.0.0.1 (free port). Logs one line per request to out/requests.log."""
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            body = {}
        with open(OUT / "requests.log", "a") as f:
            f.write(f"tag={os.environ.get('CASCADE_REQ_TAG', '')} path={self.path} n={body.get('n', 1)}\n")
        ans = json.dumps({"summary": "Fixture reviewed by the fake server; nothing blocking.", "findings": []})
        out = json.dumps({"choices": [{"index": i, "finish_reason": "stop", "message": {"role": "assistant", "content": ans}}
                                      for i in range(int(body.get("n", 1) or 1))],
                          "usage": {"prompt_tokens": 1, "completion_tokens": 1}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    srv = HTTPServer(("127.0.0.1", 0), H)
    (OUT / "port").write_text(str(srv.server_port))
    srv.serve_forever()
