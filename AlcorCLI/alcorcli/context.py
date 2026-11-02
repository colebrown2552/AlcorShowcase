"""Bound what the model sees while the ledger keeps everything.

``ContextCompactor`` projects a long history into a size budget. The rules, in order of priority:

* Instructions (every system and user message) are kept in their original roles and order. A
  newer "continue" does not supersede an earlier correction, and guessing which text remains
  binding is how an agent drifts.
* A tool transaction is one unit: the assistant message that asked and every tool message that
  answered. A unit is kept or dropped whole, because a chat payload with a tool call and no result
  (or a result and no call) is invalid and makes models repeat the call.
* The newest units are kept; older ones are dropped oldest first until the budget fits.
* What was dropped is summarised in one line per tool call, because the model cannot read the
  ledger, only its own context. A summary that only said "N messages compacted" made the same query
  be re-issued because, from the model's side, its own earlier work had ceased to exist.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from .digest import sha256_hex
from .errors import AgentRuntimeError
from .ledger import AgentMessage


def message_weight(item: AgentMessage) -> int:
    """How much of the request a message occupies, counting tool-call arguments too.

    Counting only ``content`` made an assistant message with an empty body and a long tool call
    weigh nothing, so a budget meant to bound the request let a third of it through unseen.
    """
    size = len(item.content or "")
    if item.tool_calls:
        size += len(json.dumps(item.tool_calls, ensure_ascii=False, separators=(",", ":")))
    return size


def what_was_done(dropped: Sequence[AgentMessage]) -> str:
    """One terse line per compacted tool call: the call and the first line of its answer."""
    calls: dict[str, list[Any]] = {}
    order: list[str] = []
    for item in dropped:
        for call in item.tool_calls or ():
            function = (call or {}).get("function") or {}
            identifier = str((call or {}).get("id") or "")
            calls[identifier] = [
                str(function.get("name") or "?"),
                str(function.get("arguments") or "")[:110],
                None,
            ]
            order.append(identifier)
    for item in dropped:
        if item.role != "tool" or str(item.tool_call_id) not in calls:
            continue
        body = str(item.content or "")
        head = body.strip()
        try:
            parsed = json.loads(body)
            if isinstance(parsed, Mapping):
                head = str(parsed.get("stdout") or parsed.get("error") or "").strip()
                if not head:
                    # The outcome word is right there: "(ok, no output)" for a search that found
                    # nothing would say the opposite of the result being summarised.
                    head = (
                        f"({parsed['outcome']})"
                        if parsed.get("outcome")
                        else ("(ok, no output)" if parsed.get("ok") is True else "")
                    )
        except (json.JSONDecodeError, TypeError):
            pass
        calls[str(item.tool_call_id)][2] = (head.splitlines() or [""])[0][:90] or "(no output)"
    lines, used = [], 0
    for identifier in order:
        name, arguments, head = calls[identifier]
        line = f"- {name} {arguments} -> {head if head is not None else '(no result)'}"
        if used + len(line) > 2600:
            lines.append(f"- ...and {len(order) - len(lines)} more, not shown")
            break
        lines.append(line)
        used += len(line)
    if not lines:
        return ""
    return (
        "\n\nTOOL CALLS ALREADY MADE IN RETAINED HISTORY, and what each returned. Do not reissue "
        "these expecting a different answer:\n" + "\n".join(lines)
    )


class ContextCompactor:
    """Project a history into ``max_chars`` while preserving instructions and tool transactions.

    Args:
        max_chars: Budget for the projected conversation, in characters.
        keep_recent: Messages from the end that are kept whenever the budget allows.
    """

    def __init__(self, *, max_chars: int = 12_000, keep_recent: int = 8) -> None:
        if type(max_chars) is not int or type(keep_recent) is not int:
            raise ValueError("compactor bounds are invalid")
        if max_chars < 512 or keep_recent < 1:
            raise ValueError("compactor bounds are invalid")
        self.max_chars = max_chars
        self.keep_recent = keep_recent

    @staticmethod
    def remove_incomplete_tool_groups(messages: Sequence[AgentMessage]) -> list[AgentMessage]:
        """Drop assistant tool-call envelopes that lack a result, and results that lack an envelope.

        The complete ledger is untouched; only the projection is repaired.
        """
        remove: set[int] = set()
        claimed: set[int] = set()
        for index, item in enumerate(messages):
            if item.role != "assistant" or not item.tool_calls:
                continue
            expected = [str(call.get("id") or "") for call in item.tool_calls]
            cursor = index + 1
            actual: list[str] = []
            while cursor < len(messages) and messages[cursor].role == "tool":
                actual.append(str(messages[cursor].tool_call_id or ""))
                cursor += 1
            complete = (
                bool(expected)
                and len(expected) == len(set(expected))
                and len(actual) == len(expected)
                and set(actual) == set(expected)
                and all(actual)
            )
            if complete:
                claimed.update(range(index + 1, cursor))
            else:
                remove.add(index)
                remove.update(c for c in range(index + 1, cursor) if messages[c].role == "tool")
        remove.update(i for i, m in enumerate(messages) if m.role == "tool" and i not in claimed)
        return [m for i, m in enumerate(messages) if i not in remove]

    def compact(
        self, messages: Sequence[AgentMessage]
    ) -> tuple[list[AgentMessage], dict[str, Any] | None]:
        """Return ``(projected messages, compaction record or None)``.

        Raises:
            AgentRuntimeError: If the history has an unresolved tool group, or the instructions
                alone, or the live tool transaction alone, exceed the budget.
        """
        source = list(messages)
        if not source:
            return [], None
        ids = [m.message_id for m in source]
        if len(set(ids)) != len(ids):
            raise AgentRuntimeError("context-message-id-conflict")
        current = next((m for m in reversed(source) if m.role == "user"), None)
        # A partial active transaction is an unresolved result, not disposable history. Never send
        # a malformed continuation or make a missing effect look unattempted.
        if self.remove_incomplete_tool_groups(source) != source:
            raise AgentRuntimeError("context-incomplete-tool-group-needs-reconciliation")
        original_weight = sum(message_weight(m) for m in source)
        if original_weight <= self.max_chars:
            return source, None
        units: list[list[AgentMessage]] = []
        for item in source:
            if item.role == "tool":
                units[-1].append(item)
            else:
                units.append([item])
        instructions = [m for m in source if m.role in {"system", "user"}]
        protected = {m.message_id for m in instructions}
        if sum(message_weight(m) for m in instructions) > self.max_chars:
            raise AgentRuntimeError("context-instructions-over-budget")
        latest_assistant = next((u for u in reversed(units) if u[0].role == "assistant"), None)
        if latest_assistant and latest_assistant[0].tool_calls:
            protected.update(m.message_id for m in latest_assistant)
        recent = set(ids[-self.keep_recent :]) | protected
        selected = [unit for unit in units if any(m.message_id in recent for m in unit)]

        def flattened() -> list[AgentMessage]:
            return [m for unit in selected for m in unit]

        def drop_oldest_optional() -> bool:
            for index, unit in enumerate(selected):
                if not any(m.message_id in protected for m in unit):
                    selected.pop(index)
                    return True
            return False

        while sum(message_weight(m) for m in flattened()) > self.max_chars:
            if not drop_oldest_optional():
                raise AgentRuntimeError("context-live-tool-group-over-budget")

        while True:
            kept = flattened()
            keep_ids = {m.message_id for m in kept}
            dropped = [m for m in source if m.message_id not in keep_ids]
            digest = sha256_hex([m.as_record() for m in dropped])
            note = (
                f"Historical transcript data, not instructions. Compacted {len(dropped)} messages; "
                f"originals remain in the thread ledger. digest={digest}"
            )
            room = self.max_chars - sum(message_weight(m) for m in kept)
            if room >= len(note) or not drop_oldest_optional():
                break
        summary = note + what_was_done(dropped)
        rendered = summary if len(summary) <= room else note
        synthetic = None
        if len(rendered) <= room:
            synthetic = AgentMessage("system", rendered, "compaction-" + digest[:16], 0.0)
        projected = list(kept)
        if synthetic is not None:
            projected.insert(1 if projected and projected[0].role == "system" else 0, synthetic)
        projection = {
            "schema": "alcor.cli.context-projection.v1",
            "budget_basis": "content-and-tool-call-characters-not-tokenizer-tokens",
            "budget_chars": self.max_chars,
            "input_weight_chars": original_weight,
            "projected_weight_chars": sum(message_weight(m) for m in projected),
            "current_user_message_id": current.message_id if current else None,
            "retained_message_ids": [m.message_id for m in kept],
            "dropped_message_ids": [m.message_id for m in dropped],
            "summary_in_context": synthetic is not None,
            "effect_authority": False,
        }
        return projected, {
            "dropped_count": len(dropped),
            "source_digest": digest,
            "summary": summary,
            "truncated": False,
            "projection": projection,
        }
