"""The receipt log: an append-only, hash-chained record of everything the gate decided or did.

Every gate writes here: a model call, a policy decision, an admitted or refused effect, a memory
admission. A receipt carries hashes and counts, never the private text it is about, and it never
grants anything (``effect_authority`` is always false).

Each row names the id of the row before it, and its own id is the SHA-256 of its content. Editing,
deleting or reordering a row therefore breaks every id after it, and ``verify`` finds the break.
Appends are serialised by a sidecar lock and fsynced, so a crash leaves either the old log or the
old log plus one complete row.

An append re-reads the whole file under the lock to find the previous row. That is fine for a local
audit trail of thousands of rows; a log of millions would need the head kept in an index.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .digest import canonical_json, sha256_hex, utc_iso
from .errors import ReceiptError
from .portable_lock import sidecar_lock

SCHEMA = "alcor.receipt.v1"


def _decode_rows(data: bytes) -> list[dict[str, Any]]:
    """Parse the log bytes into rows, refusing a torn or malformed file."""
    if not data:
        return []
    if not data.endswith(b"\n"):
        # A missing final newline means a write was cut short. Do not guess what it held.
        raise ReceiptError("receipt-log-torn-tail")
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(data.decode("utf-8").splitlines(), 1):
        try:
            row = json.loads(line)
        except ValueError as exc:
            raise ReceiptError("receipt-log-invalid-json", f"line {number}") from exc
        if not isinstance(row, dict):
            raise ReceiptError("receipt-log-invalid-row", f"line {number}")
        rows.append(row)
    return rows


def _row_id(row: Mapping[str, Any]) -> str:
    return sha256_hex({key: value for key, value in row.items() if key != "id"})


class ReceiptLog:
    """One JSONL file of chained receipts.

    Args:
        path: The log file. It and its directory are created on the first append.
        clock: Returns the current epoch time. Tests and the demo pass a fixed clock so the
            same run produces the same receipt ids.
    """

    def __init__(self, path: Path | str, *, clock: Callable[[], float] = time.time) -> None:
        self.path = Path(path).expanduser().resolve()
        self._clock = clock

    def _read(self) -> list[dict[str, Any]]:
        try:
            return _decode_rows(self.path.read_bytes())
        except FileNotFoundError:
            return []
        except OSError as exc:
            raise ReceiptError("receipt-log-unreadable") from exc

    def append(self, kind: str, body: Mapping[str, Any]) -> dict[str, Any]:
        """Add one receipt and return the stored row.

        Args:
            kind: What happened, e.g. ``tool.decision`` or ``model.call``.
            body: JSON-serialisable facts: hashes, counts and reason codes.

        Raises:
            ReceiptError: If the body is not strict JSON, the log is torn, or the write fails.
                The caller decides whether an effect may proceed without its receipt.
        """
        try:
            clean_body = json.loads(canonical_json(dict(body)))
        except (TypeError, ValueError) as exc:
            raise ReceiptError("receipt-body-invalid", str(exc)[:120]) from exc
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with sidecar_lock(self.path):
                rows = self._read()
                row: dict[str, Any] = {
                    "schema": SCHEMA,
                    "seq": len(rows) + 1,
                    "kind": str(kind),
                    "utc": utc_iso(self._clock()),
                    "prev": rows[-1]["id"] if rows else "",
                    "body": clean_body,
                    "effect_authority": False,
                }
                row["id"] = _row_id(row)
                line = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                    handle.write(line + "\n")
                    handle.flush()
                    os.fsync(handle.fileno())
        except ReceiptError:
            raise
        except OSError as exc:
            raise ReceiptError("receipt-log-write-failed", type(exc).__name__) from exc
        return row

    def rows(self) -> list[dict[str, Any]]:
        """Return every receipt, oldest first."""
        with sidecar_lock(self.path):
            return self._read()

    def tail(self, count: int = 10) -> list[dict[str, Any]]:
        """Return the newest ``count`` receipts, oldest first."""
        return self.rows()[-max(0, count) :]

    def head(self) -> str:
        """Return the id of the newest receipt, or an empty string for an empty log."""
        rows = self.rows()
        return rows[-1]["id"] if rows else ""

    def find(self, receipt_id: str) -> dict[str, Any] | None:
        """Return the receipt with this id, or None."""
        return next((row for row in self.rows() if row.get("id") == receipt_id), None)

    def verify(self) -> dict[str, Any]:
        """Check the whole chain.

        Returns:
            ``{"ok", "count", "head", "reason"}``. ``reason`` names the first row that fails.
        """
        try:
            rows = self.rows()
        except ReceiptError as exc:
            return {"ok": False, "count": 0, "head": "", "reason": exc.code}
        previous = ""
        for index, row in enumerate(rows, 1):
            if row.get("schema") != SCHEMA:
                return self._broken(index, previous, "schema-mismatch")
            if row.get("seq") != index:
                return self._broken(index, previous, "sequence-gap")
            if row.get("prev") != previous:
                return self._broken(index, previous, "previous-id-mismatch")
            if row.get("effect_authority") is not False:
                return self._broken(index, previous, "receipt-claims-authority")
            if row.get("id") != _row_id(row):
                return self._broken(index, previous, "content-hash-mismatch")
            previous = row["id"]
        return {"ok": True, "count": len(rows), "head": previous, "reason": ""}

    @staticmethod
    def _broken(index: int, head: str, reason: str) -> dict[str, Any]:
        return {"ok": False, "count": index - 1, "head": head, "reason": f"row {index}: {reason}"}
