"""The effect gate: every tool call passes a program before it runs.

The host computes *cells* about a call: what kind of tool it is, whether every path it names stays
inside the allowed roots, whether a shell command matches a forbidden or owner-class pattern,
whether the owner enabled effects. ``tool.alcor`` turns those cells into a verdict (allow, deny or
ask the owner) and the host obeys it.

The two sides split the work along one line. The host does the arithmetic that needs I/O, such as
resolving a path and comparing it with the roots, and reports the answer as a cell. The program
owns the policy over those cells: which kinds of effect may run, what an outside path or a
forbidden pattern means, and when the owner has to enable an effect first. A program has no I/O,
so it cannot be asked to resolve a path; the host has no policy, so it cannot decide what to do
about one.

Unavailable is deny: a call the program could not judge does not run. A decision whose receipt
cannot be written does not run either.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .config import Scope
from .digest import sha256_hex
from .errors import AgentRuntimeError, PolicyError, ReceiptError, ToolDenied, TurnInterrupted
from .limits import MAX_TOOL_RESULT_CHARS
from .policy import PolicyHost
from .receipts import ReceiptLog

TOOL_PROGRAM = "tool"
TOOL_REQUEST_SCHEMA = "alcor.cli.tool.request.v1"
TOOL_DECISION_SCHEMA = "alcor.cli.tool.decision.v1"

# Declared next to the tools rather than inferred from a name: guessing "is this a write?" from a
# string is how an incident starts.
TOOL_KIND = {
    "shell": "shell",
    "write_file": "write",
    "append_file": "write",
    "edit_file": "write",
    "read_file": "read",
    "list_dir": "read",
    "search_repo": "read",
    "recall": "memory",
    "remember": "memory",
    "ask_owner": "owner",
    "consult": "model",
    "fetch": "network",
}

FORBIDDEN_PATTERNS = (
    r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(/|~|\$HOME)(\s|$|/\*)",
    r"(^|[\s'\"/=])\.ssh\b",
    r"/etc/(passwd|shadow|sudoers)",
    r"\bsecurity\s+find-(generic|internet)-password",
    r"\bgit\s+push\b.*(--force\b|\s-f\b)",
    r"\blaunchctl\s+(unload|bootout|remove)\b",
    r"\bdiskutil\s+(erase|reformat)",
    r"\bmkfs\b",
    r"\b(shutdown|reboot)\b",
    r"\b(Stop|Restart)-Computer\b",
    r"\bFormat-Volume\b",
    r"\bRemove-Item\b.*-Recurse\b.*\.alcor\b",
    r"\bcurl\b.*\|\s*(ba|z)?sh\b",
    # Synthetic input has its own admitted route; a shell command may not forge it.
    r"\bSendKeys\b|\bSendInput\b|\bkeybd_event\b|\bPostMessage\b|\bmouse_event\b",
    # Closing or killing a process a person is using is forbidden outright, whatever the grant.
    r"(?is)(?:Stop-Process|taskkill|\.Kill\(\)|CloseMainWindow\(\)|\bkill\b|\bpkill\b).*?"
    r"\b(?:conhost|explorer|cmd|powershell|pwsh|WindowsTerminal|chrome|firefox|msedge|Code)\b",
)

# Effects that are allowed, but only after the owner enabled effects for this invocation.
OWNER_PATTERNS = (
    r"\bgit\s+push\b",
    r"\blaunchctl\s+(load|bootstrap|kickstart)\b",
    r"\b(pip3?|npm|brew)\s+install\b",
    r"\b(kill|killall|pkill)\b",
    r"\bStop-Process\b",
    r"\bcrontab\b",
    r"\bschtasks\s+/delete\b",
    r"\btaskkill\b",
    r"\.Kill\(\)",
    r"\.CloseMainWindow\(\)",
)

# Arguments that name a path to read or write, and the subset that names where bytes land.
PATH_ARGS = ("path", "local", "file")
WRITE_DEST_ARGS = ("path", "out", "local", "file")


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """One registered tool.

    Attributes:
        name: The name the model calls.
        description: Shown to the model.
        handler: Runs the tool. Called only after the gate admitted the call.
        mutating: True when calling the tool changes something.
        parameters: JSON schema of the arguments.
    """

    name: str
    description: str
    handler: Callable[[Mapping[str, Any]], Any]
    mutating: bool = False
    parameters: Mapping[str, Any] | None = None


def _shell_effect_text(name: str, arguments: Mapping[str, Any]) -> str:
    """Read exactly the argument field the named executor consumes."""
    return str(arguments.get("command") or "") if name == "shell" else ""


def tool_cells(
    name: str,
    mutating: bool,
    arguments: Mapping[str, Any],
    owner_enabled: bool,
    scope: Scope,
) -> dict[str, str]:
    """Compute the facts ``tool.alcor`` decides on. Pure: no I/O beyond resolving paths.

    Args:
        name: The tool name.
        mutating: Whether the registry marked the tool as changing something.
        arguments: The call's arguments, as the model supplied them.
        owner_enabled: True only when the operator enabled effects for this invocation. It comes
            from the host, never from model output.
        scope: The roots and protected inputs.
    """
    kind = TOOL_KIND.get(name) or ("write" if mutating else "read")
    inside, effect, forbidden, protected = "yes", kind, "no", "no"
    if kind == "shell":
        text = _shell_effect_text(name, arguments)
        if any(re.search(pattern, text) for pattern in FORBIDDEN_PATTERNS):
            forbidden = "yes"
        elif any(re.search(pattern, text) for pattern in OWNER_PATTERNS):
            effect = "owner"
    elif kind in ("read", "write"):
        # Every path argument is resolved the way the tool will resolve it. Checking only values
        # that contain a slash would wave a bare relative name through while the tool resolved it
        # somewhere else.
        for key in PATH_ARGS:
            value = arguments.get(key)
            if isinstance(value, str) and value.strip() and not scope.contains(value):
                inside = "no"
        if kind == "write":
            for key in WRITE_DEST_ARGS:
                value = arguments.get(key)
                if isinstance(value, str) and value.strip() and scope.is_protected(value):
                    protected = "yes"
    if owner_enabled or kind == "owner":
        owner = "proceed"
    else:
        owner = (
            "ask" if (mutating or effect in ("write", "shell", "network", "owner")) else "proceed"
        )
    return {
        "schema": TOOL_REQUEST_SCHEMA,
        "effect_authority": "false",
        "tool_kind": kind,
        "inside_root": inside,
        "effect_class": effect,
        "owner_verdict": owner,
        "forbidden_pattern": forbidden,
        "protected_input": protected,
    }


def admit_tool_call(
    name: str,
    mutating: bool,
    arguments: Mapping[str, Any],
    owner_enabled: bool,
    *,
    scope: Scope,
    policy: PolicyHost,
    receipts: ReceiptLog | None = None,
) -> dict[str, Any]:
    """Consult ``tool.alcor`` and return its verdict, receipting every decision.

    Returns:
        ``{"verdict": "allow"|"deny"|"ask_owner", "reason": code, "cells": {...},
        "receipt_id": id}``. Unavailable is deny, and so is a decision that could not be
        receipted.
    """
    cells = tool_cells(name, mutating, arguments, owner_enabled, scope)
    policy_receipt: Mapping[str, Any] = {}
    try:
        decision = policy.decide(TOOL_PROGRAM, cells, TOOL_DECISION_SCHEMA)
        verdict = {"verdict": decision.get("verdict") or "deny", "reason": decision.get("reason")}
        policy_receipt = decision.receipt
    except PolicyError as exc:
        verdict = {"verdict": "deny", "reason": f"tool-program-unavailable: {exc.code}"}
    receipt_id = ""
    if receipts is not None:
        try:
            row = receipts.append(
                "tool.decision",
                {
                    "tool": name,
                    "cells": {
                        k: v for k, v in cells.items() if k not in ("schema", "effect_authority")
                    },
                    "args_sha256": sha256_hex(dict(arguments)),
                    "policy_receipt": dict(policy_receipt),
                    **verdict,
                },
            )
            receipt_id = row["id"]
        except ReceiptError:
            verdict = {"verdict": "deny", "reason": "receipt-store-unavailable"}
    return {**verdict, "cells": cells, "receipt_id": receipt_id}


def render_result(value: Any) -> str:
    """Render a tool result as text no longer than ``MAX_TOOL_RESULT_CHARS``.

    JSON is never cut at an arbitrary character: a malformed tool result makes a model repeat the
    call. An oversized object keeps its shape, loses the tail of its largest string field, and
    says so with ``truncated`` and the SHA-256 of the full result.
    """
    if isinstance(value, str):
        return value[:MAX_TOOL_RESULT_CHARS]
    rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(rendered) <= MAX_TOOL_RESULT_CHARS:
        return rendered
    digest = sha256_hex(rendered)
    if isinstance(value, Mapping):
        strings = sorted(
            ((str(k), v) for k, v in value.items() if isinstance(v, str)),
            key=lambda pair: len(pair[1]),
            reverse=True,
        )
        for field, original in strings:
            base = dict(value)
            base.update({field: "", "truncated": True, "result_sha256": digest})
            low, high, best = 0, len(original), ""
            while low <= high:
                middle = (low + high) // 2
                base[field] = original[:middle]
                candidate = json.dumps(
                    base, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                if len(candidate) <= MAX_TOOL_RESULT_CHARS:
                    best, low = candidate, middle + 1
                else:
                    high = middle - 1
            if best:
                return best
    return json.dumps(
        {
            "ok": False,
            "error": "tool result exceeded the bounded response limit",
            "truncated": True,
            "result_sha256": digest,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


class ToolRegistry:
    """The tools an agent may call, each reachable only through the gate.

    Args:
        tools: The registered tools.
        scope: Roots and protected inputs used to compute cells. Defaults to the current
            directory, which suits a test; real callers pass the configured scope.
        policy: The policy host that runs ``tool.alcor``.
        receipts: Where decisions are recorded. With no log, decisions are not recorded.
    """

    def __init__(
        self,
        tools: Iterable[ToolSpec] = (),
        *,
        scope: Scope | None = None,
        policy: PolicyHost | None = None,
        receipts: ReceiptLog | None = None,
    ) -> None:
        self._tools = {tool.name: tool for tool in tools}
        if any(not name or name != name.strip() for name in self._tools):
            raise AgentRuntimeError("tool-name-invalid")
        self.scope = scope if scope is not None else Scope.for_workspace(".")
        self.policy = policy if policy is not None else PolicyHost()
        self.receipts = receipts

    def names(self) -> list[str]:
        """Registered tool names, sorted."""
        return sorted(self._tools)

    def spec(self, name: str) -> ToolSpec | None:
        """The registered tool with this name, or None."""
        return self._tools.get(name)

    def schemas(self) -> list[dict[str, Any]]:
        """The tool list in OpenAI function-calling form."""
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": dict(tool.parameters or {"type": "object"}),
                },
            }
            for tool in self._tools.values()
        ]

    def is_mutating(self, name: str) -> bool:
        """True when calling this tool changes something. Unknown tools count as mutating.

        Defaulting an unknown name to mutating is deliberate: the caller uses this to decide
        whether a cached result may stand in for a real call, and guessing "harmless" there
        would fabricate an effect that never happened.
        """
        tool = self._tools.get(name)
        return True if tool is None else bool(tool.mutating)

    def invoke(
        self,
        name: str,
        arguments: Any,
        *,
        owner_enabled: bool,
        guard: Callable[[], Any] | None = None,
    ) -> str:
        """Admit a call, run it, and return its bounded result text.

        Args:
            name: The tool to call.
            arguments: The model-supplied arguments, a mapping.
            owner_enabled: Set by the host from the operator's flag. Never taken from the model.
            guard: Called after admission and before the handler, so a STOP or deadline that
                arrives during admission still prevents the effect.

        Raises:
            ToolDenied: If the program denied the call or it waits for owner enablement.
            AgentRuntimeError: If the tool is unknown or the arguments are not an object.
            TurnInterrupted: If the guard stopped the turn.
        """
        tool = self._tools.get(name)
        if tool is None:
            raise AgentRuntimeError("tool-not-registered", name)
        if not isinstance(arguments, Mapping):
            raise AgentRuntimeError("tool-arguments-must-be-an-object", name)
        admitted = admit_tool_call(
            name,
            bool(tool.mutating),
            arguments,
            bool(owner_enabled),
            scope=self.scope,
            policy=self.policy,
            receipts=self.receipts,
        )
        if admitted["verdict"] != "allow":
            raise ToolDenied(
                name, str(admitted["verdict"]), str(admitted["reason"]), admitted["cells"]
            )
        if guard is not None:
            guard()
        try:
            value = tool.handler(arguments)
        except TurnInterrupted:
            raise
        except Exception as exc:
            # A tool failure becomes bounded data the model can read, not a crashed turn.
            value = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        return render_result(value)
