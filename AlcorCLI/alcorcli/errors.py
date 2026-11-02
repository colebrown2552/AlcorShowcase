"""Typed errors shared by the gate.

Every refusal carries a short, kebab-case reason code. Callers show the code to the operator and
write it into a receipt, so a refusal can be searched for and tested without parsing prose.
"""

from __future__ import annotations


class AlcorError(RuntimeError):
    """Base class for every error the gate raises on purpose.

    Attributes:
        code: Stable reason code, e.g. ``endpoint-must-be-http-loopback``.
    """

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = str(code)
        self.detail = str(detail)
        super().__init__(self.code if not detail else f"{self.code}: {detail}")


class AgentRuntimeError(AlcorError):
    """An agent request could not be completed safely."""


class TurnInterrupted(AgentRuntimeError):
    """The operator's STOP file appeared or the turn deadline passed.

    This is terminal for the turn. It is never treated as a recoverable tool error.
    """


class ToolDenied(AgentRuntimeError):
    """The effect gate refused a tool call.

    Attributes:
        verdict: ``deny`` or ``ask_owner``.
        reason: The reason code emitted by the policy program.
        cells: The facts the program decided on, for diagnosis.
    """

    def __init__(
        self, tool: str, verdict: str, reason: str, cells: dict[str, str] | None = None
    ) -> None:
        self.tool = tool
        self.verdict = verdict
        self.reason = reason
        self.cells = dict(cells or {})
        code = "tool-requires-owner-enablement" if verdict == "ask_owner" else "tool-denied"
        super().__init__(code, f"{tool}: {reason}")


class EndpointRefused(AlcorError):
    """A model endpoint was refused before any byte was sent to it."""


class ReceiptError(AlcorError):
    """The receipt log is unreadable, torn, or does not verify."""


class PolicyError(AlcorError):
    """A policy program could not be consulted.

    This is different from a program that answered "no". Callers treat it as a refusal.
    """
