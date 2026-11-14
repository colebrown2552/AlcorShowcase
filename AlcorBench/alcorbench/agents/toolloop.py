"""A minimal coding agent: one chat-completions tool loop over urllib.

It speaks the OpenAI-compatible /v1/chat/completions protocol with function
calling, so it runs against a local server (vLLM, llama.cpp, Ollama) or a
hosted API. The scaffold is deliberately small and fixed so that a score
measures the model, and a scaffold change shows up as a separate result.
"""

from __future__ import annotations

import http.client
import json
import math
import os
import re
import shutil
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..config import DEFAULTS, option
from ..sandbox import CommandResult, PathEscape, resolve_inside, run_command, scrubbed_env
from .base import Agent, AgentResult, Budget, RunAborted

REMINDER = ("Use the tools to make and check the change, or call finish if the work is"
            " already done.")
RETRY_STATUSES = {429, 502, 503, 504}  # busy or restarting server: worth waiting for
READ_LIMIT = 20_000
LIST_LIMIT = 400
EDIT_TOOLS = ("write_file", "replace_in_file")
BATCH_HINT = (" You may issue several tool calls in one turn, and they run in order, so read every"
              " file you need at once rather than one file per turn.")
TREE_LIMIT = 200  # entries in the prefetch file tree
SMALL_TEST_BYTES = 4_000  # test files up to this size go into the prefetch packet
TEST_TAIL_LINES = 40


def _fn(name: str, description: str, props: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


_S = {"type": "string"}
TOOLS = [
    _fn("run_shell", "Run a shell command in the repository root and return its exit code and output.",
        {"command": _S}, ["command"]),
    _fn("read_file", "Return the text of a file.", {"path": _S}, ["path"]),
    _fn("write_file", "Create or overwrite a file with the given content.",
        {"path": _S, "content": _S}, ["path", "content"]),
    _fn("replace_in_file", "Replace one exact occurrence of old with new in a file. "
        "old must appear exactly once.", {"path": _S, "old": _S, "new": _S}, ["path", "old", "new"]),
    _fn("list_files", "List files under a directory, recursively (default: the repository root).",
        {"path": _S}, []),
    _fn("finish", "Call when the work is done.", {"summary": _S}, ["summary"]),
]


def clip(text: str, limit: int) -> str:
    """Keep the head and tail of long output; the middle is rarely what matters."""
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n[... {len(text) - 2 * half} characters omitted ...]\n{text[-half:]}"


def _tree(root: Path) -> list[Path]:
    """Regular files under root, outside .git, never through a symlink."""
    files = []
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if ".git" in rel.parts or p.is_symlink() or not p.is_file():
            continue
        if any((root / Path(*rel.parts[:i])).is_symlink() for i in range(1, len(rel.parts))):
            continue
        files.append(p)
    return files


def detect_test_command(root: Path, configured: str | None = None) -> str | None:
    """The project's test command: the configured one, else unittest (pytest only if used).

    A tests/ directory or test_*.py files mean tests; neither means no command.
    """
    if configured:
        return configured
    tests = [p for p in _tree(root) if p.name.startswith("test_") and p.suffix == ".py"]
    if not tests and not (root / "tests").is_dir():
        return None
    uses_pytest = (root / "conftest.py").is_file() or any(
        re.search(r"^\s*(import|from)\s+pytest\b", p.read_text(encoding="utf-8", errors="replace"),
                  re.M) for p in tests)
    if uses_pytest:
        probe = run_command(["python3", "-c", "import pytest"], cwd=root,
                            env=scrubbed_env(root), timeout_s=20)
        if probe.returncode == 0:
            return "python3 -m pytest -q"
    if (root / "tests").is_dir():
        top = " -t ." if (root / "tests" / "__init__.py").is_file() else ""
        return f"python3 -m unittest discover -s tests{top}"
    return "python3 -m unittest discover -s . -p 'test_*.py'"


def context_packet(root: Path, brief: str, budget: int, test_command: str | None) -> str:
    """File tree, files the brief names (then small test files) and the test command.

    Everything comes from inside root; the packet is at most `budget` UTF-8 bytes.
    """
    root = root.resolve()
    files = _tree(root)
    rels = [p.relative_to(root).as_posix() for p in files]
    names = [r.rsplit("/", 1)[-1] for r in rels]

    def named(rel: str, name: str) -> bool:
        if re.search(rf"(?<![\w/.-]){re.escape(rel)}(?![\w-])", brief):
            return True  # by path; a bare file name counts only when it is unique
        return names.count(name) == 1 and "." in name and bool(
            re.search(rf"(?<![\w/.-]){re.escape(name)}(?![\w-])", brief))

    wanted = [r for r, n in zip(rels, names) if named(r, n)]
    wanted += [r for p, r in zip(files, rels) if r not in wanted and p.name.startswith("test_")
               and p.suffix == ".py" and p.stat().st_size <= SMALL_TEST_BYTES]
    marker = "\n[truncated: the packet's byte budget is used up; read_file for the rest]"
    out = "\n".join([
        "Context packet (gathered by the harness before your first turn; the files are shown"
        " as they are now):", "",
        f"Test command: {test_command}" if test_command else "Test command: none detected", "",
        "Files in the repository:"])
    for i, (p, rel) in enumerate(zip(files, rels)):
        line = f"\n{rel} ({p.stat().st_size} bytes)"
        if i >= TREE_LIMIT or len((out + line).encode()) > budget - 2 * len(marker.encode()):
            out += f"\n[... {len(files) - i} more files; list_files shows them all]"
            break
        out += line
    for rel in wanted:
        text = (root / rel).read_text(encoding="utf-8", errors="replace")
        block = f"\n\n--- {rel} ---\n{text}"
        room = budget - len(out.encode()) - len(marker.encode())
        if len(block.encode()) <= room:
            out += block
            continue
        if room > 200:
            out += block.encode()[:room].decode("utf-8", errors="ignore")
        out += marker
        break
    return out.encode()[:budget].decode("utf-8", errors="ignore")


class ToolBox:
    """The six tools, each confined to one work directory."""

    def __init__(self, workdir: Path, command_timeout_s: float, max_output: int,
                 deadline: float = math.inf) -> None:
        self.root = workdir.resolve()
        self.command_timeout_s = command_timeout_s
        self.max_output = max_output
        self.deadline = deadline  # time.monotonic() value; shell commands never run past it

    def call_raw(self, name: str, raw: object) -> str:
        """Decode tool arguments as sent by the model (usually a JSON string), then call."""
        try:
            args = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError as exc:
            return f"error: arguments are not valid JSON: {exc}"
        if not isinstance(args, dict):
            return "error: arguments must be a JSON object"
        return self.call(name, args)

    def call(self, name: str, args: dict) -> str:
        """Run one tool; every failure becomes a message for the model, not an exception."""
        handler = getattr(self, f"tool_{name}", None)
        if handler is None:
            return f"error: unknown tool {name!r}"
        try:
            return handler(**args)
        except TypeError as exc:
            return f"error: bad arguments for {name}: {exc}"
        except (PathEscape, OSError, UnicodeError) as exc:
            return f"error: {exc}"

    def _shell(self, command: str) -> tuple[CommandResult, float]:
        shell = shutil.which("bash") or "/bin/sh"
        timeout = max(0.0, min(self.command_timeout_s, self.deadline - time.monotonic()))
        return run_command([shell, "-c", command], cwd=self.root,
                           env=scrubbed_env(self.root), timeout_s=timeout), timeout

    def tool_run_shell(self, command: str) -> str:
        res, timeout = self._shell(command)
        head = (f"timed out after {timeout:.0f}s" if res.timed_out
                else f"exit code: {res.returncode}")
        return f"{head}\n{clip(res.output, self.max_output)}"

    def run_tests(self, command: str) -> tuple[bool, str, float]:
        """Run the test command: (passed, a clipped summary for the model, seconds)."""
        res, timeout = self._shell(command)
        lines = res.output.rstrip().splitlines()
        if res.returncode == 0:
            tail = "\n".join(lines[-3:])
            return True, f"tests pass (`{command}`, exit 0)\n{tail}", res.wall_s
        head = (f"timed out after {timeout:.0f}s" if res.timed_out
                else f"exit code {res.returncode}")
        tail = clip("\n".join(lines[-TEST_TAIL_LINES:]), self.max_output)
        return False, f"tests FAIL (`{command}`, {head}); last lines:\n{tail}", res.wall_s

    def _file(self, path: str, must_exist: bool = True) -> Path:
        """A path inside the work directory that is a regular file (a FIFO would block)."""
        target = resolve_inside(self.root, path)
        if target.exists() or must_exist:
            if not target.is_file():
                raise OSError(f"not a regular file: {path}")
        return target

    def tool_read_file(self, path: str) -> str:
        text = self._file(path).read_text(encoding="utf-8", errors="replace")
        return clip(text, READ_LIMIT)

    def tool_write_file(self, path: str, content: str) -> str:
        target = self._file(path, must_exist=False)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"wrote {len(content)} characters to {path}"

    def tool_replace_in_file(self, path: str, old: str, new: str) -> str:
        target = self._file(path)
        text = target.read_text(encoding="utf-8")
        count = text.count(old) if old else 0
        if count != 1:
            return f"error: old text found {count} times in {path}; it must appear exactly once"
        target.write_text(text.replace(old, new, 1), encoding="utf-8")
        return f"replaced 1 occurrence in {path}"

    def tool_list_files(self, path: str = ".") -> str:
        base = resolve_inside(self.root, path)
        if not base.is_dir():
            return f"error: not a directory: {path}"
        entries = []
        for p in sorted(base.rglob("*")):
            rel = p.relative_to(self.root)
            if ".git" in rel.parts:
                continue
            entries.append(rel.as_posix() + ("/" if p.is_dir() else ""))
        more = f"\n[... {len(entries) - LIST_LIMIT} more]" if len(entries) > LIST_LIMIT else ""
        return "\n".join(entries[:LIST_LIMIT]) + more or "(empty)"

    def tool_finish(self, summary: str = "") -> str:
        return "finished"


@dataclass
class ToolLoopConfig:
    """Endpoint settings plus the resolved agent config (prompt, sampling, extra body)."""

    base_url: str = "http://127.0.0.1:8000/v1"
    model: str = ""  # also the lane: one request in flight per model id
    api_key_env: str = "OPENAI_API_KEY"
    agent_config: dict = field(default_factory=lambda: dict(DEFAULTS))
    request_timeout_s: float = 300.0
    retries: int = 4
    backoff_s: float = 2.0
    max_output_chars: int = 8000


class EndpointError(RuntimeError):
    """The endpoint gave no usable reply (after retries, where retrying made sense).

    kind is "infra" (unreachable or busy), "client" (a 4xx) or "other".
    """

    def __init__(self, message: str, kind: str = "other") -> None:
        super().__init__(message)
        self.kind = kind


def assistant_message(resp: object) -> dict:
    """The assistant message of a chat completion, or EndpointError if there is none.

    A 200 with an error body or no choices is no model output, so it is not a
    turn; it is graded as a failure (kind "other"), not dropped as an outage.
    """
    choices = resp.get("choices") if isinstance(resp, dict) else None
    first = choices[0] if isinstance(choices, list) and choices else None
    msg = first.get("message") if isinstance(first, dict) else None
    if not isinstance(msg, dict):
        raise EndpointError(f"response has no assistant message: {str(resp)[:300]}")
    return msg


class ToolLoopAgent(Agent):
    name = "toolloop"

    def __init__(self, config: ToolLoopConfig) -> None:
        self.config = config
        self.lane = config.model

    def options(self) -> dict:
        """Endpoint settings; the model is the lane and the agent config is recorded apart."""
        opts = asdict(self.config)
        del opts["model"], opts["agent_config"]
        return opts

    def _post(self, payload: dict, deadline: float) -> dict:
        """POST with bounded retries and exponential backoff on busy/unreachable servers.

        Retried: no connection, HTTP 429/502/503/504, and a timeout before any
        byte of the reply arrived. Those end as kind "infra". A 4xx is "client";
        anything else (another 5xx, a reply that stalls or is not JSON) is "other".
        No attempt or backoff runs past the deadline (a time.monotonic() value).
        """
        url = self.config.base_url.rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        key = os.environ.get(self.config.api_key_env, "") if self.config.api_key_env else ""
        if key:
            headers["Authorization"] = f"Bearer {key}"
        data = json.dumps(payload).encode()
        last = "out of time before the request could be sent"
        for attempt in range(self.config.retries + 1):
            if attempt:
                pause = self.config.backoff_s * 2 ** (attempt - 1)
                if time.monotonic() + pause >= deadline:
                    break
                time.sleep(pause)
            timeout_s = min(self.config.request_timeout_s, deadline - time.monotonic())
            if timeout_s <= 0:
                break
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            try:
                resp = urllib.request.urlopen(req, timeout=timeout_s)
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")[:300]
                last = f"HTTP {exc.code}: {body}"
                if exc.code not in RETRY_STATUSES:
                    raise EndpointError(last, "client" if exc.code < 500 else "other") from exc
                continue
            except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
                last = f"request failed before any reply: {exc}"  # no bytes received
                continue
            try:  # the reply has started: a failure from here on is not an outage
                with resp:
                    return json.loads(resp.read())
            except (OSError, http.client.HTTPException) as exc:
                raise EndpointError(f"reply started but did not complete: {exc}", "other") from exc
            except json.JSONDecodeError as exc:
                raise EndpointError(f"response is not JSON: {exc}", "other") from exc
        raise EndpointError(last, "infra")

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int = 0) -> AgentResult:
        c, ac = self.config, self.config.agent_config
        start = time.monotonic()
        deadline = start + budget.wall_s
        tools = ToolBox(workdir, budget.command_timeout_s, c.max_output_chars, deadline)
        auto_test, gate = option(ac, "auto_test"), option(ac, "finish_gate")
        prefetch = option(ac, "prefetch")
        test_cmd = (detect_test_command(workdir, option(ac, "test_command"))
                    if auto_test or gate or prefetch else None)
        system = ac["system_prompt"] + (BATCH_HINT if option(ac, "batch_hint") else "")
        if prefetch:
            packet = context_packet(workdir, prompt, int(option(ac, "prefetch_bytes")), test_cmd)
            prompt = f"{prompt}\n\n{packet}"
        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
        result = AgentResult(transcript_path=str(transcript_path))
        with open(transcript_path, "w", encoding="utf-8") as log:

            def record(entry: dict) -> None:
                log.write(json.dumps(entry) + "\n")
                log.flush()

            for m in messages:
                record(m)
            result.status = "timeout"  # unless the model finishes inside the budget
            reminders = 1
            try:
                while result.turns < budget.max_turns and time.monotonic() < deadline:
                    payload = {"model": c.model, "messages": messages, "tools": TOOLS,
                               "tool_choice": "auto", "temperature": ac["temperature"],
                               "seed": seed}
                    if ac["max_tokens"]:
                        payload["max_tokens"] = ac["max_tokens"]
                    payload.update(ac["extra_body"])
                    resp = self._post(payload, deadline)
                    msg = assistant_message(resp)  # no message: not a turn, may be infra
                    result.turns += 1
                    usage = resp.get("usage") or {}
                    result.final_prompt_tokens = int(usage.get("prompt_tokens") or 0)
                    result.input_tokens += int(usage.get("prompt_tokens") or 0)
                    result.output_tokens += int(usage.get("completion_tokens") or 0)
                    result.model = resp.get("model") or result.model
                    calls = msg.get("tool_calls") or []
                    assistant = {"role": "assistant", "content": msg.get("content") or ""}
                    if calls:
                        assistant["tool_calls"] = calls
                    messages.append(assistant)
                    record({**assistant, "usage": usage})
                    if not calls:
                        # Text without a tool call: remind once; only finish ends a trial.
                        if reminders == 0:
                            result.status = "error"
                            result.error = "the model stopped without calling finish"
                            break
                        reminders -= 1
                        messages.append({"role": "user", "content": REMINDER})
                        record(messages[-1])
                        continue
                    refused = False  # a finish refused by the gate: answer the rest unrun
                    for call in calls:
                        if (result.tool_calls >= budget.max_tool_calls
                                or time.monotonic() >= deadline):
                            break
                        fn = call.get("function") or {}
                        name = fn.get("name", "")
                        if refused:
                            output = "not run: finish was called earlier in this message"
                        else:
                            result.tool_calls += 1
                            result.tool_counts[name] = result.tool_counts.get(name, 0) + 1
                            output = tools.call_raw(name, fn.get("arguments") or "{}")
                        if (name in EDIT_TOOLS and not refused and auto_test and test_cmd
                                and not output.startswith("error")):
                            _, summary, secs = tools.run_tests(test_cmd)
                            result.auto_tests += 1
                            result.auto_test_s += secs
                            output += f"\n\nauto-test: {summary}"
                        if (name == "finish" and not refused and gate and test_cmd
                                and result.finish_gate_rejections
                                < int(option(ac, "finish_gate_repairs"))):
                            ok, summary, _ = tools.run_tests(test_cmd)
                            if not ok:
                                result.finish_gate_rejections += 1
                                refused = True
                                output = f"not finished: tests fail\n{summary}"
                        tool_msg = {"role": "tool", "tool_call_id": call.get("id", ""),
                                    "content": output}
                        messages.append(tool_msg)
                        record(tool_msg)
                        if name == "finish" and not refused:
                            result.status = "finished"  # later calls in it are not run
                            break
                    if result.status == "finished" or result.tool_calls >= budget.max_tool_calls:
                        break
            except EndpointError as exc:
                if exc.kind == "client" and result.turns == 0:
                    record({"event": "end", "status": "aborted", "error": str(exc)})
                    raise RunAborted(
                        f"the endpoint rejected the first request ({exc}); every trial would"
                        " fail the same way. Check --base-url, --model, the API key and"
                        " extra_body.") from exc
                result.status, result.error = "error", str(exc)
                # Only an unreachable or busy endpoint before any model output means the
                # task was never attempted. Anything else is graded like any failure.
                result.infra_error = exc.kind == "infra" and result.turns == 0
            except (AttributeError, KeyError, TypeError, ValueError) as exc:
                # A malformed response; keep the counters gathered so far.
                result.status = "error"
                result.error = f"malformed response: {type(exc).__name__}: {exc}"
            record({"event": "end", "status": result.status, "error": result.error})
        result.wall_s = time.monotonic() - start
        return result
