"""An oracle that applies the task's reference solution: the upper bound."""

from __future__ import annotations

import time
from pathlib import Path

from ..tasks import Task, apply_reference
from .base import Agent, AgentResult, Budget


class ReferenceAgent(Agent):
    name = "reference"

    def __init__(self) -> None:
        self.task: Task | None = None

    def prepare(self, task: Task) -> None:
        self.task = task

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int = 0) -> AgentResult:
        if self.task is None:
            return AgentResult(status="error", error="reference agent was not prepared")
        start = time.monotonic()
        apply_reference(self.task, workdir)
        return AgentResult(status="finished", wall_s=time.monotonic() - start)
