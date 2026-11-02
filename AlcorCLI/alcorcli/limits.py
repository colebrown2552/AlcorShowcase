"""Size limits and the one text validator the gate uses at its boundaries.

Every limit exists because an unbounded value is a way to blow the model's context or the disk,
not a feature. The numbers are generous for real work and small enough to stay predictable.
"""

from __future__ import annotations

from .errors import AgentRuntimeError

MAX_TEXT_CHARS = 65_536
MAX_TOOL_RESULT_CHARS = 16_384
# Sized for a tool call that carries a whole file: ``write_file`` puts the content in one argument
# string, so the ceiling has to sit well above the largest file an agent is expected to write.
MAX_TOOL_ARGUMENT_CHARS = 262_144
MAX_GOAL_CHARS = 4_096


def bounded_text(value: object, *, field: str, maximum: int = MAX_TEXT_CHARS) -> str:
    """Return ``value`` if it is a non-blank string within ``maximum`` characters and has no NUL.

    Raises:
        AgentRuntimeError: Otherwise, naming the field so the caller can report which input.
    """
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise AgentRuntimeError(
            "text-out-of-bounds",
            f"{field} must be a nonempty string of at most {maximum} characters",
        )
    if "\x00" in value:
        raise AgentRuntimeError("text-has-nul-byte", field)
    return value
