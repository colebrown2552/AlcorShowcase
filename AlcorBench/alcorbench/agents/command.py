"""Run any external agent CLI through a command template.

Placeholders: {prompt_file} (the brief, written outside the work directory),
{workdir} and {usage_file}. The command may write JSON to {usage_file} with
input_tokens, output_tokens, turns and tool_calls; those are copied into the
result. The command runs with cwd = workdir and a scrubbed environment; pass
the variables it needs (an API key, say) by name with --pass-env.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
from pathlib import Path

from ..sandbox import run_command, scrubbed_env
from .base import Agent, AgentResult, Budget

USAGE_FIELDS = ("input_tokens", "output_tokens", "turns", "tool_calls")


class CommandAgent(Agent):
    name = "command"

    def __init__(self, template: str, pass_env: list[str] | None = None) -> None:
        if "{prompt_file}" not in template:
            raise ValueError("the command template must contain {prompt_file}")
        self.template = template
        self.pass_env = pass_env or []

    def options(self) -> dict:
        return {"template": self.template, "pass_env": self.pass_env}

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int = 0) -> AgentResult:
        side = workdir.parent  # beside the work directory, so the agent's diff stays clean
        prompt_file, usage_file = side / "prompt.md", side / "usage.json"
        prompt_file.write_text(prompt, encoding="utf-8")
        usage_file.unlink(missing_ok=True)
        cmd = self.template  # plain replace, so other braces in the command survive
        for key, value in (("prompt_file", prompt_file), ("workdir", workdir),
                           ("usage_file", usage_file)):
            cmd = cmd.replace("{" + key + "}", shlex.quote(str(value)))
        passed = {k: os.environ[k] for k in self.pass_env if k in os.environ}
        shell = shutil.which("bash") or "/bin/sh"
        res = run_command([shell, "-c", cmd], cwd=workdir, env=scrubbed_env(workdir, passed),
                          timeout_s=budget.wall_s)
        transcript_path.write_text(res.output, encoding="utf-8")
        result = AgentResult(wall_s=res.wall_s, transcript_path=str(transcript_path))
        if res.timed_out:
            result.status = "timeout"
        elif res.returncode != 0:
            result.status, result.error = "error", f"command exited with {res.returncode}"
        if usage_file.is_file():
            try:
                usage = json.loads(usage_file.read_text(encoding="utf-8"))
                for key in USAGE_FIELDS:
                    setattr(result, key, int(usage.get(key) or 0))
            except (ValueError, TypeError, AttributeError) as exc:
                result.error = (result.error + f"; bad usage file: {exc}").lstrip("; ")
        return result
