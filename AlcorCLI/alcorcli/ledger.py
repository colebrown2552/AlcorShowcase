"""The thread ledger: one conversation, appended and never rewritten.

The full history stays on disk; the model only ever sees a bounded projection of it (see
``context.ContextCompactor``). Every append takes a cross-process lock and is fsynced, so two
processes (or two threads) writing the same thread interleave whole records, never fragments, and
a crash leaves either the old ledger or the old ledger plus one complete record.

A final answer is committed in two steps: a ``completion_pending`` draft, then the ordinary
assistant message. A reader that ignores non-message rows therefore never replays a draft as
accepted history, and a failure after the commit write began is reported as *uncertain* (it may or
may not be on disk) instead of being retried into a duplicate.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import AgentRuntimeError
from .limits import MAX_TEXT_CHARS, bounded_text
from .portable_lock import sidecar_lock
from .transport import normalise_tool_call

LEDGER_SCHEMA = "alcor.cli.agent-thread.v1"
MESSAGE_SCHEMA = "alcor.cli.agent-message.v1"
COMPACTION_SCHEMA = "alcor.cli.agent-compaction.v1"
ROLES = frozenset({"system", "user", "assistant", "tool"})


class CompletionPersistenceUncertain(AgentRuntimeError):
    """The final commit write started and then failed; its bytes must be reconciled before retry."""

    def __init__(self, message_id: str, user_message_id: str) -> None:
        super().__init__("agent-completion-persistence-uncertain", message_id)
        self.message_id = message_id
        self.request_user_message_id = user_message_id

    def as_result(self) -> dict[str, Any]:
        """The failure as a turn result: ambiguous, and never automatically retried."""
        return {
            "failure_class": self.code,
            "error": self.code,
            "message_id": self.message_id,
            "request_user_message_id": self.request_user_message_id,
            "completion_commit_state": "unknown",
            "outcome_ambiguous": True,
            "automatic_retry_allowed": False,
        }


@dataclass(frozen=True, slots=True)
class AgentMessage:
    """One chat message, as stored and as sent to the model."""

    role: str
    content: str
    message_id: str
    created_epoch: float
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: tuple[Mapping[str, Any], ...] | None = None

    def as_api(self) -> dict[str, Any]:
        """The message in OpenAI chat form."""
        value: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.name:
            value["name"] = self.name
        if self.tool_call_id:
            value["tool_call_id"] = self.tool_call_id
        if self.tool_calls is not None:
            value["tool_calls"] = [dict(call) for call in self.tool_calls]
        return value

    def as_record(self) -> dict[str, Any]:
        """The message as a ledger record."""
        return {
            "schema": MESSAGE_SCHEMA,
            "role": self.role,
            "content": self.content,
            "message_id": self.message_id,
            "created_epoch": self.created_epoch,
            "name": self.name,
            "tool_call_id": self.tool_call_id,
            "tool_calls": [dict(c) for c in self.tool_calls]
            if self.tool_calls is not None
            else None,
        }


def _safe_role(value: object) -> str:
    if value not in ROLES:
        raise AgentRuntimeError("message-role-invalid")
    return str(value)


def _message_from_record(value: Mapping[str, Any]) -> AgentMessage:
    if value.get("schema") != MESSAGE_SCHEMA:
        raise AgentRuntimeError("ledger-unknown-message-schema")
    role = _safe_role(value.get("role"))
    raw_calls = value.get("tool_calls")
    calls: tuple[Mapping[str, Any], ...] | None = None
    if raw_calls is not None:
        if not isinstance(raw_calls, list):
            raise AgentRuntimeError("ledger-tool-calls-malformed")
        normalised = tuple(normalise_tool_call(call, require_id=True) for call in raw_calls)
        calls = normalised if normalised else None
    raw_content = value.get("content")
    allow_empty = role == "assistant" and calls is not None
    content = (
        raw_content
        if allow_empty and raw_content == ""
        else bounded_text(raw_content, field="message content")
    )
    try:
        created = float(value.get("created_epoch"))  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise AgentRuntimeError("message-timestamp-invalid") from exc
    return AgentMessage(
        role=role,
        content=content,
        message_id=bounded_text(value.get("message_id"), field="message id", maximum=128),
        created_epoch=created,
        name=str(value["name"]) if value.get("name") else None,
        tool_call_id=str(value["tool_call_id"]) if value.get("tool_call_id") else None,
        tool_calls=calls,
    )


class ThreadLedger:
    """Append-only local ledger for one thread; it never truncates historical turns.

    Args:
        path: The JSONL file. Created on first append.
        thread_id: Names the thread. Every record carries it and a mismatch is an error.
        clock: Returns epoch time; tests pass a fixed clock.
    """

    def __init__(
        self, path: Path | str, *, thread_id: str, clock: Callable[[], float] = time.time
    ) -> None:
        self.path = Path(path).expanduser().resolve()
        self.thread_id = bounded_text(thread_id, field="thread id", maximum=128)
        self._clock = clock

    def _append(
        self,
        record: Mapping[str, Any],
        *,
        guard: Callable[[], Any] | None = None,
        completion_commit: bool = False,
    ) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(dict(record), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        write_started = False
        try:
            with (
                sidecar_lock(self.path),
                self.path.open("a", encoding="utf-8", newline="\n") as handle,
            ):
                if guard is not None:
                    guard()  # After the lock, immediately before admitting the write.
                write_started = True
                handle.write(line + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except Exception as exc:
            if completion_commit and write_started:
                # A failed write, flush, fsync or close may have persisted all or some bytes.
                # Never retract them or imply that this turn is safe to retry.
                raise CompletionPersistenceUncertain(
                    str(record["message_id"]), str(record["request_user_message_id"])
                ) from exc
            raise

    def append_message(
        self,
        role: str,
        content: str,
        *,
        name: str | None = None,
        tool_call_id: str | None = None,
        tool_calls: Sequence[Mapping[str, Any]] | None = None,
    ) -> AgentMessage:
        """Append one message and return it."""
        safe_role = _safe_role(role)
        calls = (
            tuple(normalise_tool_call(c, require_id=True) for c in tool_calls)
            if tool_calls
            else None
        )
        if safe_role == "assistant" and calls is not None and content == "":
            safe_content = ""
        else:
            safe_content = bounded_text(content, field="message content")
        message = AgentMessage(
            role=safe_role,
            content=safe_content,
            message_id=uuid.uuid4().hex,
            created_epoch=self._clock(),
            name=name,
            tool_call_id=tool_call_id,
            tool_calls=calls,
        )
        self._append(
            {
                "schema": LEDGER_SCHEMA,
                "thread_id": self.thread_id,
                "kind": "message",
                **message.as_record(),
            }
        )
        return message

    def append_completion(
        self, content: str, *, user_message_id: str, guard: Callable[[], Any]
    ) -> AgentMessage:
        """Persist a draft, then commit only a freshly guarded final answer.

        Readers ignore non-message rows, so a crash or refusal after the draft cannot replay it
        as accepted history. The ordinary assistant message is the commit record.
        """
        message = AgentMessage(
            role="assistant",
            content=bounded_text(content, field="message content"),
            message_id=uuid.uuid4().hex,
            created_epoch=self._clock(),
        )
        record = {
            "schema": LEDGER_SCHEMA,
            "thread_id": self.thread_id,
            "request_user_message_id": user_message_id,
            **message.as_record(),
        }
        self._append({**record, "kind": "completion_pending"})
        self._append(
            {**record, "kind": "message", "completion_of": message.message_id},
            guard=guard,
            completion_commit=True,
        )
        return message

    def append_compaction(
        self,
        *,
        dropped_count: int,
        source_digest: str,
        summary: str,
        truncated: bool = False,
        projection: Mapping[str, Any] | None = None,
    ) -> None:
        """Record that the projection sent to the model left some history out."""
        self._append(
            {
                "schema": LEDGER_SCHEMA,
                "thread_id": self.thread_id,
                "kind": "compaction",
                "compaction_schema": COMPACTION_SCHEMA,
                **({"projection": dict(projection)} if projection is not None else {}),
                "dropped_count": int(dropped_count),
                # Dropping whole messages and cutting one are different losses.
                "truncated": bool(truncated),
                "source_digest": source_digest,
                "summary": bounded_text(
                    summary, field="compaction summary", maximum=MAX_TEXT_CHARS
                ),
                "created_epoch": self._clock(),
            }
        )

    def messages(self) -> list[AgentMessage]:
        """Every committed message, oldest first. Drafts and compaction records are skipped."""
        result: list[AgentMessage] = []
        with sidecar_lock(self.path):
            if not self.path.is_file():
                return []
            with self.path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    try:
                        value = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise AgentRuntimeError("ledger-invalid-json") from exc
                    if not isinstance(value, dict) or value.get("thread_id") != self.thread_id:
                        raise AgentRuntimeError("ledger-record-malformed")
                    if value.get("kind") == "message":
                        result.append(_message_from_record(value))
        return result
