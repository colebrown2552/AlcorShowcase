"""The agent interface the runner drives."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..config import DEFAULTS
from ..tasks import Task


class RunAborted(RuntimeError):
    """Every trial would fail the same way (a rejected model id or key): stop the run."""


@dataclass
class Budget:
    max_turns: int
    max_tool_calls: int
    wall_s: float
    command_timeout_s: float

    @classmethod
    def from_config(cls, config: dict = DEFAULTS) -> Budget:
        return cls(max_turns=int(config["max_turns"]),
                   max_tool_calls=int(config["max_tool_calls"]),
                   wall_s=float(config["wall_time_s"]),
                   command_timeout_s=float(config["command_timeout_s"]))


@dataclass
class AgentResult:
    status: str = "finished"  # finished | timeout (a budget ran out) | error
    turns: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    wall_s: float = 0.0
    transcript_path: str = ""
    error: str = ""
    model: str = ""  # model id as reported by the endpoint, when there is one
    # True only when the endpoint was unreachable or busy (or sent nothing
    # before a timeout) before the model produced any turn: the task was never
    # attempted, so the trial is retried, not graded.
    infra_error: bool = False
    tool_counts: dict[str, int] = field(default_factory=dict)  # executed tool calls by name
    final_prompt_tokens: int = 0  # prompt tokens of the last turn: the final context size
    auto_tests: int = 0  # test runs appended to edit replies (auto_test option)
    auto_test_s: float = 0.0
    finish_gate_rejections: int = 0  # finish calls refused because the tests failed

    def to_dict(self) -> dict:
        return asdict(self)


class Agent:
    """Base class. Subclasses override run(); oracles also override prepare()."""

    name = "base"
    lane = ""  # the endpoint lane (model id) this instance is pinned to, if any

    def prepare(self, task: Task) -> None:
        """Called before each run. Model agents ignore it: they get only the brief.

        Oracle agents (reference, scripted) use it to see the task's solution.
        """

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int) -> AgentResult:
        """Attempt the task in workdir. seed is derived from (run seed, task, trial)."""
        raise NotImplementedError

    def options(self) -> dict:
        """Settings needed to rebuild this agent on --resume; never includes secrets."""
        return {}
