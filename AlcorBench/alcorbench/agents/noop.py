"""An agent that changes nothing: the lower bound every check must fail."""

from __future__ import annotations

from pathlib import Path

from .base import Agent, AgentResult, Budget


class NoopAgent(Agent):
    name = "noop"

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int = 0) -> AgentResult:
        return AgentResult(status="finished")
