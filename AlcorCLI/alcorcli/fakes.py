"""Stand-ins for the parts of the full system that are private or need real hardware.

* ``FakeProvider`` is a small OpenAI-compatible HTTP server on loopback. It answers from a script,
  so the real guarded transport, the real loopback checks and the real response admission run
  against a real socket, with canned text on the other end.
* ``ScriptedTransport`` is the same script without the socket, for unit-level tests of the agent.
* ``RecordingShell`` is an in-memory effect target. It records the command an agent asked for and
  returns a canned result; it never executes anything.

Nothing here pretends to be a model. Token counts in ``usage`` are character counts divided by
four, and the text is whatever the script says.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Mapping, Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .digest import sha256_hex
from .tools import ToolSpec

ScriptItem = Any  # str | dict | Callable[[Mapping[str, Any]], str | dict]
DEFAULT_REPLY = "(the fake provider has nothing scripted)"


def say(text: str) -> dict[str, Any]:
    """A script item: the assistant answers with plain text and stops."""
    return {"content": text}


def call(
    name: str, arguments: Mapping[str, Any], call_id: str | None = None, content: str = ""
) -> dict[str, Any]:
    """A script item: the assistant asks for one tool call.

    The default call id is derived from the call itself, so a script produces the same ids on
    every run. Pass distinct ids when the same call is repeated on purpose.
    """
    identifier = call_id or "call-" + sha256_hex({"name": name, "arguments": dict(arguments)})[:8]
    return {
        "content": content,
        "tool_calls": [
            {
                "id": identifier,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(dict(arguments))},
            }
        ],
    }


def build_completion(model: str, item: ScriptItem, request: Mapping[str, Any]) -> dict[str, Any]:
    """Turn one script item into a complete chat-completion object."""
    if callable(item):
        item = item(request)
    if isinstance(item, str):
        item = {"content": item}
    if isinstance(item, Mapping) and "choices" in item:
        completion = dict(item)
        completion.setdefault("model", model)
        return completion
    content = str(item.get("content") or "")
    message: dict[str, Any] = {"role": "assistant", "content": content}
    tool_calls = item.get("tool_calls")
    if tool_calls:
        message["tool_calls"] = list(tool_calls)
    prompt_chars = sum(len(str(m.get("content") or "")) for m in request.get("messages") or ())
    prompt_tokens, completion_tokens = prompt_chars // 4, len(content) // 4 + 1
    return {
        "id": "fake-" + sha256_hex({"model": model, "content": content})[:8],
        "object": "chat.completion",
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


class ScriptedTransport:
    """An in-process ``ChatTransport`` that answers from a script.

    Attributes:
        payloads: Every payload received, in order.
    """

    def __init__(self, script: Sequence[ScriptItem] = (), *, model: str = "demo-model") -> None:
        self.script = list(script)
        self.model = model
        self.payloads: list[dict[str, Any]] = []

    def complete(
        self, payload: Mapping[str, Any], *, timeout: float, **options: Any
    ) -> Mapping[str, Any]:
        """Record the payload and return the next scripted completion."""
        self.payloads.append(dict(payload))
        item = self.script.pop(0) if self.script else DEFAULT_REPLY
        return build_completion(self.model, item, payload)


class FakeProvider:
    """A loopback OpenAI-compatible server that answers from a script.

    Use it as a context manager. ``base`` is ``http://127.0.0.1:<port>`` on an ephemeral port.

    Args:
        model: The model id reported by ``/v1/models`` and echoed in every response.
        script: Items consumed one per ``/v1/chat/completions`` request.
        default_reply: What the provider answers once the script runs out.

    Attributes:
        requests: Every chat request body received, in order.
    """

    def __init__(
        self,
        *,
        model: str = "demo-model",
        script: Sequence[ScriptItem] = (),
        default_reply: str = DEFAULT_REPLY,
    ) -> None:
        self.model = model
        self.script = list(script)
        self.default_reply = default_reply
        self.requests: list[dict[str, Any]] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    @property
    def base(self) -> str:
        """The URL to give to a lane. Only valid while the provider is running."""
        if self._server is None:
            raise RuntimeError("fake provider is not running")
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def _reply(self, body: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self.requests.append(body)
            item = self.script.pop(0) if self.script else self.default_reply
        return build_completion(self.model, item, body)

    def start(self) -> str:
        """Start serving on an ephemeral loopback port and return the base URL."""
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                return None

            def _send(self, status: int, payload: Mapping[str, Any]) -> None:
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                if self.path == "/v1/models":
                    self._send(200, {"object": "list", "data": [{"id": provider.model}]})
                else:
                    self._send(404, {"error": "no such route"})

            def do_POST(self) -> None:
                if self.path != "/v1/chat/completions":
                    self._send(404, {"error": "no such route"})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    self._send(400, {"error": "body must be JSON"})
                    return
                self._send(200, provider._reply(body))

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self.base

    def stop(self) -> None:
        """Stop serving and release the port."""
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> FakeProvider:
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()


class RecordingShell:
    """An in-memory effect target standing in for a real shell.

    It records every command and returns a canned result. The full system runs commands in a
    sandboxed session; this stand-in exists so the gate's decisions can be shown without running
    anything on the reader's machine.

    Attributes:
        commands: Every command that was admitted and handed to the target.
    """

    def __init__(self, outputs: Mapping[str, str] | None = None) -> None:
        self.outputs = dict(outputs or {})
        self.commands: list[str] = []

    def __call__(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        """Record the command and return what the canned table says."""
        command = str(arguments.get("command") or "")
        self.commands.append(command)
        return {
            "ok": True,
            "stdout": self.outputs.get(command, "(recorded, not executed)"),
            "executed": False,
        }

    def spec(self) -> ToolSpec:
        """The ``shell`` tool backed by this target."""
        return ToolSpec(
            name="shell",
            description="Run a shell command (recorded by an in-memory target, never executed).",
            handler=self,
            mutating=True,
            parameters={
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        )
