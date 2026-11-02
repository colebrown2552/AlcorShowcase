"""Telling the agent that it is repeating itself, and whether the world answered differently.

Nothing in an agent loop looks at what comes *back* from a tool unless it is told to: results are
cached and re-served, never compared. So a model can issue the same call dozens of times and the
loop is perfectly content. This module keeps a digest history per exact call (tool name plus
arguments) and annotates a repeated result with how many times it was seen before and whether it
changed. Whether the repeat also ends the round is not decided here: ``kernel.alcor`` owns that.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from .digest import sha256_hex
from .ledger import AgentMessage


def result_digest(result: str) -> str:
    """Hash a tool answer, ignoring the annotation this module adds to repeats."""
    try:
        parsed = json.loads(str(result))
    except (json.JSONDecodeError, TypeError):
        return sha256_hex(str(result))
    if isinstance(parsed, dict):
        parsed = {key: value for key, value in parsed.items() if key != "repeat"}
    return sha256_hex(parsed)


def repeat_note(history: dict[str, list[str]], call_key: str, result: str) -> dict[str, Any] | None:
    """Record ``result`` against ``call_key`` and describe the repeat, or return None if new."""
    digest = result_digest(result)
    seen = history.setdefault(call_key, [])
    note = None
    if seen:
        same = digest == seen[-1]
        note = {
            "times_before": len(seen),
            "same_result": same,
            "note": (
                "identical call and identical result to your last one; nothing changed"
                if same
                else "same call as before; the result differs, the world changed"
            ),
        }
    seen.append(digest)
    return note


def with_repeat_note(result: str, note: dict[str, Any] | None) -> str:
    """Attach the note to a JSON result, or prefix a plain-text one with it."""
    if not note:
        return result
    try:
        parsed = json.loads(result)
    except (json.JSONDecodeError, TypeError):
        parsed = None
    if isinstance(parsed, dict):
        parsed["repeat"] = note
        return json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
    return f"[repeat: {note['note']}]\n{result}"


def prior_call_history(messages: Iterable[AgentMessage]) -> dict[str, list[str]]:
    """Seed the history from a thread ledger, so a restarted process remembers too."""
    keys: dict[str, str] = {}
    history: dict[str, list[str]] = {}
    for item in messages:
        if item.role == "assistant" and item.tool_calls:
            for call in item.tool_calls:
                function = call.get("function") or {}
                keys[str(call.get("id"))] = f"{function.get('name')}\n{function.get('arguments')}"
        elif item.role == "tool" and item.tool_call_id in keys:
            history.setdefault(keys[item.tool_call_id], []).append(result_digest(item.content))
    return history
