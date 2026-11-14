"""End-to-end demo with no model: the real tool loop against a fake endpoint.

A local HTTP server speaks just enough of /v1/chat/completions to replay a
canned tool-call script derived from the task's reference files. The real
ToolLoopAgent drives it, so CI exercises HTTP, retry on 503, tool-call
parsing, the file tools and the shell tool. Results are a demo, never a score.
"""

from __future__ import annotations

import json
import shlex
import threading
import time
from collections.abc import Container
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ..tasks import Task
from .base import Agent, AgentResult, Budget
from .toolloop import ToolLoopAgent, ToolLoopConfig

DEMO_MODEL = "scripted-demo"


Call = tuple[str, dict]  # (tool name, arguments)


def script_for(task: Task) -> list[list[Call]]:
    """One tool call per step: inspect the repo, write the reference, delete, check, finish."""
    fixture = task.path / "fixture"
    refs = task.reference_files()
    steps: list[Call] = [("list_files", {})]
    steps += [("read_file", {"path": rel}) for rel in refs if (fixture / rel).is_file()]
    steps += [("write_file", {"path": rel, "content": data.decode("utf-8")})
              for rel, data in refs.items()]
    steps += [("run_shell", {"command": f"rm -f -- {shlex.quote(rel)}"})
              for rel in task.reference_deletions()]
    steps += [("run_shell", {"command": "git status --short"}),
              ("finish", {"summary": "applied the reference change"})]
    return [[call] for call in steps]


class FakeEndpoint:
    """Serves canned scripts, chosen by the task brief in the user message.

    Step i answers the request that carries i assistant turns, so the server
    keeps no per-conversation state. A step is a list of tool calls sent in one
    message; an empty step is a text-only reply. `stall_s` pauses between the
    reply headers and its body, to stage a reply that starts and then overruns. Requests whose 1-based number is in
    `busy` get `busy_reply` (503 by default), which lets the selfcheck stage
    outages; `delay_s` slows every answer so that parallel lanes overlap.
    """

    def __init__(self, tasks: list[Task], busy: Container[int] = (1,),
                 delay_s: float = 0.0,
                 busy_reply: tuple[int, dict] = (503, {"error": "busy"}),
                 stall_s: float = 0.0) -> None:
        self.scripts = {task.brief: script_for(task) for task in tasks}
        self.busy = busy
        self.busy_reply = busy_reply
        self.stall_s = stall_s
        self.delay_s = delay_s
        self.requests = 0
        self.models: set[str] = set()  # model ids seen, to check lane pinning
        self.seeds: set[int] = set()
        self.tool_errors: list[str] = []
        self.first_messages: list[str] = []  # the first user message of each request
        self.lock = threading.Lock()
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                status, reply = endpoint.answer(self.path, body)
                data = json.dumps(reply).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.flush()
                    time.sleep(endpoint.stall_s)
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the client gave up first (a timeout test): nothing to answer

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def answer(self, path: str, body: dict) -> tuple[int, dict]:
        time.sleep(self.delay_s)
        with self.lock:
            self.requests += 1
            if self.requests in self.busy:
                return self.busy_reply
            self.models.add(body.get("model", ""))
            self.seeds.add(body.get("seed"))
        if not path.endswith("/chat/completions"):
            return 404, {"error": "not found"}
        messages = body.get("messages", [])
        first = next((m["content"] for m in messages if m.get("role") == "user"), "")
        # The brief opens the first user message; a prefetch packet may follow it.
        brief = next((b for b in self.scripts if first == b or first.startswith(b + "\n\n")), None)
        if brief is None:
            return 400, {"error": "unknown task"}
        with self.lock:
            self.first_messages.append(first)
        for m in messages[-1:]:
            if m.get("role") == "tool" and m.get("content", "").startswith("error"):
                with self.lock:
                    self.tool_errors.append(m["content"])
        steps = self.scripts[brief]
        step = sum(1 for m in messages if m.get("role") == "assistant")
        calls = steps[min(step, len(steps) - 1)]
        tool_calls = [{"id": f"call_{step}_{i}", "type": "function",
                       "function": {"name": name, "arguments": json.dumps(args)}}
                      for i, (name, args) in enumerate(calls)]
        message = ({"role": "assistant", "content": None, "tool_calls": tool_calls} if calls
                   else {"role": "assistant", "content": "The change looks complete."})
        return 200, {
            "id": f"demo-{self.requests}",
            "object": "chat.completion",
            "model": DEMO_MODEL,
            "choices": [{"index": 0, "message": message,
                         "finish_reason": "tool_calls" if calls else "stop"}],
            # Rough character-based counts so the token columns are exercised.
            "usage": {"prompt_tokens": len(json.dumps(messages)) // 4,
                      "completion_tokens": len(json.dumps(message)) // 4},
        }

    def __enter__(self) -> FakeEndpoint:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()


class ScriptedAgent(Agent):
    name = "scripted"

    def __init__(self) -> None:
        self.task: Task | None = None

    def prepare(self, task: Task) -> None:
        self.task = task

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int = 0) -> AgentResult:
        if self.task is None:
            return AgentResult(status="error", error="scripted agent was not prepared")
        with FakeEndpoint([self.task]) as fake:
            config = ToolLoopConfig(base_url=fake.base_url, model=DEMO_MODEL,
                                    api_key_env="", backoff_s=0.05)
            result = ToolLoopAgent(config).run(prompt, workdir, budget, transcript_path, seed)
        if fake.tool_errors and result.status == "finished":
            result.status, result.error = "error", "tool error: " + fake.tool_errors[0][:200]
        return result
