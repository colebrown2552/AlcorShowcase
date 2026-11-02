"""Writes that prove themselves.

These tools add accountability, not power. A shell can write anything they can; what a shell cannot
do is make the write *checkable*: ``echo x > y`` buried in a multi-line block leaves nothing but the
agent's account of what happened.

So every write here reads itself back. The tool writes, re-opens the file, hashes what is actually
on disk and returns that. The agent does not get to say the write succeeded; the receipt says it,
and the receipt was produced by re-reading rather than by remembering. A write tool that returns
only ``ok=True`` reproduces exactly the failure of an agent that reports "ledger updated" when the
ledger is unchanged.

The roots here are the second line of defence. The first is the gate: ``tool.alcor`` has already
refused a path outside the roots before the handler runs, and the tool re-checks the same resolved
path so a handler called directly cannot skip it.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .config import Scope
from .errors import ReceiptError
from .fsutil import atomic_replace, decode_bytes, encode_text
from .receipts import ReceiptLog
from .tools import ToolSpec

MAX_WRITE_BYTES = 512 * 1024
NO_CONTENT = (
    'no content given; write_file needs the body. To empty a file deliberately pass content="".'
)
NO_NEW_STRING = (
    "no new_string given; edit_file needs the replacement. To delete the anchor deliberately "
    'pass new_string="".'
)


def _not_encodable(exc: Exception) -> dict[str, Any]:
    return {
        "ok": False,
        "status": "refused",
        "error": f"content is not encodable as UTF-8 ({str(exc)[:80]}); nothing was written",
    }


class WriteTools:
    """The three write tools, bound to a scope and a receipt log.

    Args:
        scope: Where writes may land and which inputs are read-only.
        receipts: Where each write is recorded. With no log, writes are not recorded.
    """

    def __init__(self, scope: Scope, receipts: ReceiptLog | None = None) -> None:
        self.scope = scope
        self.receipts = receipts

    def _receipt(self, row: dict[str, Any]) -> bool:
        """Record one write. The write already happened, so a failure is reported, not raised."""
        if self.receipts is None:
            return False
        try:
            self.receipts.append("effect.write", row)
        except ReceiptError:
            return False
        return True

    def _refusal(self, path: str) -> dict[str, Any] | None:
        if not self.scope.contains(path):
            return {
                "ok": False,
                "status": "refused",
                "error": "path is outside the allowed roots; nothing was written",
            }
        if self.scope.is_protected(path):
            return {
                "ok": False,
                "status": "refused",
                "error": "path is a protected input and is read-only; write the output elsewhere",
            }
        return None

    def _verified(self, path: Path, expected: bytes) -> dict[str, Any]:
        """Read back what is actually on disk and hash it. This is the proof."""
        try:
            raw = path.read_bytes()
        except OSError as exc:
            return {"ok": False, "error": f"wrote but could not read back: {str(exc)[:120]}"}
        matches = raw == expected
        return {
            "ok": matches,
            "path": self.scope.display(path),
            "bytes_on_disk": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            # Said explicitly, because "I wrote it" and "it is there" are different claims.
            "verified_by_reading_back": True,
            **({} if matches else {"error": "what is on disk does not match what was written"}),
        }

    def write_file(self, path: str, content: str | None, append: bool = False) -> dict[str, Any]:
        """Write or append ``content`` and verify it by reading the file back."""
        if not str(path or "").strip():
            return {"ok": False, "error": "no path given"}
        # Absence is not the empty string. A call that names the file and leaves the body out is
        # the commonest malformation from a small model; collapsing it to "" would truncate the
        # file and then prove the empty file matched.
        if content is None:
            return {"ok": False, "status": "refused", "error": NO_CONTENT}
        content = content if isinstance(content, str) else str(content)
        refusal = self._refusal(path)
        if refusal:
            return refusal
        target = self.scope.resolve(path)
        action = "append" if append else "write"
        # The bytes must exist before the file is touched: ``json.loads`` accepts a lone
        # surrogate, and encoding after truncation would destroy the target for nothing.
        try:
            data = encode_text(content)
        except UnicodeEncodeError as exc:
            self._receipt(
                {
                    "action": action,
                    "path": self.scope.display(target),
                    "ok": False,
                    "refused": "content-not-encodable",
                }
            )
            return _not_encodable(exc)
        if len(data) > MAX_WRITE_BYTES:
            return {"ok": False, "error": f"content exceeds {MAX_WRITE_BYTES} bytes"}
        before = hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if append:
                expected = (target.read_bytes() if target.exists() else b"") + data
                with target.open("ab") as handle:
                    handle.write(data)
            else:
                expected = data
                atomic_replace(target, data)
        except OSError as exc:
            return {"ok": False, "error": str(exc)[:160]}
        out = self._verified(target, expected)
        out["receipted"] = self._receipt(
            {
                "action": action,
                "path": self.scope.display(target),
                "sha256_before": before,
                "sha256_after": out.get("sha256"),
                "bytes": out.get("bytes_on_disk"),
                "ok": out.get("ok"),
            }
        )
        return out

    def edit_file(self, path: str, old: str, new: str | None) -> dict[str, Any]:
        """Replace one exact occurrence of ``old`` with ``new``, or refuse.

        Exact-match-or-fail is the discipline, not a limitation. If the anchor appears zero times
        the edit is refused. If it appears more than once it is also refused, with the count,
        because "which of these three did you mean" is a question the tool must not answer by
        guessing.
        """
        if not str(path or "").strip():
            return {"ok": False, "error": "no path given"}
        if not old:
            return {"ok": False, "error": "old_string may not be empty; use write_file to create"}
        if new is None:
            return {"ok": False, "status": "refused", "error": NO_NEW_STRING}
        new = new if isinstance(new, str) else str(new)
        if old == new:
            return {"ok": False, "error": "old_string and new_string are identical"}
        refusal = self._refusal(path)
        if refusal:
            return refusal
        target = self.scope.resolve(path)
        try:
            before_text = decode_bytes(target.read_bytes())
        except OSError as exc:
            return {"ok": False, "error": str(exc)[:160]}
        count = before_text.count(old)
        if count == 0:
            return {
                "ok": False,
                "error": "old_string not found in the file",
                "occurrences": 0,
                "hint": "check whitespace and indentation; the match must be exact",
            }
        if count > 1:
            return {
                "ok": False,
                "error": f"old_string appears {count} times, so the edit is ambiguous",
                "occurrences": count,
                "hint": "include more surrounding lines until the anchor is unique",
            }
        # Only the anchor changes. Every CRLF and every byte that was never UTF-8 goes back
        # exactly as it was read, because decode and encode round-trip bytes.
        try:
            data = encode_text(before_text.replace(old, new, 1))
        except UnicodeEncodeError as exc:
            self._receipt(
                {
                    "action": "edit",
                    "path": self.scope.display(target),
                    "ok": False,
                    "refused": "content-not-encodable",
                }
            )
            return _not_encodable(exc)
        try:
            atomic_replace(target, data)
        except OSError as exc:
            return {"ok": False, "error": str(exc)[:160]}
        out = self._verified(target, data)
        # Two more facts read off the disk, not asserted: the new text is there and the old is gone.
        try:
            actual = decode_bytes(target.read_bytes())
            out["new_text_present"] = new in actual if new else True
            out["old_text_gone"] = actual.count(old) == 0
            out["ok"] = bool(out.get("ok") and out["new_text_present"])
        except OSError:
            out["ok"] = False
        out["receipted"] = self._receipt(
            {
                "action": "edit",
                "path": self.scope.display(target),
                "occurrences": count,
                "sha256_after": out.get("sha256"),
                "ok": out.get("ok"),
            }
        )
        return out

    def specs(self) -> tuple[ToolSpec, ...]:
        """The three write tools, all mutating, all self-verifying."""
        path_content = {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        }

        def write(arguments: Mapping[str, Any]) -> dict[str, Any]:
            return self.write_file(str(arguments.get("path") or ""), arguments.get("content"))

        def append(arguments: Mapping[str, Any]) -> dict[str, Any]:
            return self.write_file(
                str(arguments.get("path") or ""), arguments.get("content"), append=True
            )

        def edit(arguments: Mapping[str, Any]) -> dict[str, Any]:
            return self.edit_file(
                str(arguments.get("path") or ""),
                str(arguments.get("old_string") or ""),
                arguments.get("new_string"),
            )

        return (
            ToolSpec(
                name="write_file",
                description=(
                    "Write a file and verify it by reading it back. Returns the bytes and "
                    "sha256 actually on disk, not a claim that the write worked."
                ),
                handler=write,
                mutating=True,
                parameters=path_content,
            ),
            ToolSpec(
                name="append_file",
                description="Append to a file and verify by reading it back.",
                handler=append,
                mutating=True,
                parameters=path_content,
            ),
            ToolSpec(
                name="edit_file",
                description=(
                    "Replace one exact occurrence of old_string with new_string in a file. "
                    "Refuses if the anchor is missing or appears more than once; include more "
                    "surrounding lines until it is unique. Use this instead of write_file on any "
                    "file too large to reproduce."
                ),
                handler=edit,
                mutating=True,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                    },
                    "required": ["path", "old_string", "new_string"],
                },
            ),
        )
