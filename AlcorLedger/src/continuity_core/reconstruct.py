"""Rebuild and check a three-turn continuity proof from the ledger alone.

The question this answers: after a restart, can the state of a three-turn exchange be recovered
from the append-only chain, with no cache and no live service, and does the recorded evidence hold
together? Three ledger entries tagged ``continuity-three-turn`` carry hashed metadata for turns 1
to 3. ``reconstruct`` verifies the chain, then checks the metadata and derives a state digest from
it. It reads only the ledger file and never calls a model, service or network endpoint.

What it proves is limited on purpose. It shows the recorded evidence is complete, ordered and
consistent. It does not observe the processes itself; whoever wrote the entries made the claims.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from .ledger import JsonlLedger, is_sha256_hex

# Entries carrying this tag are the proof turns; other entries in the ledger are ignored.
PROOF_TAG = "continuity-three-turn"
PROOF_SCHEMA = "alcor.continuity.three_turn.v1"
RECEIPT_SCHEMA = "alcor.continuity.three_turn.receipt.v1"


class ReconstructionError(ValueError):
    """The ledger does not satisfy the three-turn proof contract.

    The message is a short reason code such as ``cache-use-not-proven-false``.
    """


def _digest(value: Mapping[str, Any]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _proof_rows(entries: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return [entry for entry in entries if PROOF_TAG in entry.get("tags", [])]


def reconstruct(path: str | Path) -> dict[str, Any]:
    """Reconstruct the three-turn proof from the ledger chain and verify its invariants.

    The checks, in order: the chain verifies; exactly three tagged entries exist; each has the
    proof schema and the next turn index; all share one hashed thread id; each records an accepted
    result hash, exactly one terminal result, a completion receipt, no cache use, no retry of a
    quarantined request, and a hashed process marker; and turn 3 ran under a process marker
    different from turns 1 and 2.

    Args:
        path: Ledger file holding the proof entries.

    Returns:
        A receipt with ``ok`` set, the thread id hash, the derived ``state_digest`` and the
        invariants that were proven.

    Raises:
        ReconstructionError: Any check fails. The message is the reason code.
    """
    ledger = JsonlLedger(path)
    chain = ledger.verify()
    if not chain.ok:
        raise ReconstructionError("ledger-chain-invalid")

    rows = _proof_rows(ledger.entries())
    if len(rows) != 3:
        raise ReconstructionError("expected-three-turns")

    thread_hash: str | None = None
    result_hashes: list[str] = []
    process_marker_hashes: list[str] = []
    previous_index = 0

    for row in rows:
        metadata = row.get("metadata")
        if not isinstance(metadata, Mapping):
            raise ReconstructionError("turn-metadata-invalid")
        if metadata.get("proof_schema") != PROOF_SCHEMA:
            raise ReconstructionError("proof-schema-invalid")

        index = metadata.get("turn_index")
        # bool is an int subclass, so True would otherwise pass as turn 1.
        if not isinstance(index, int) or isinstance(index, bool) or index != previous_index + 1:
            raise ReconstructionError("turn-order-invalid")
        previous_index = index

        candidate_thread = metadata.get("thread_id_hash")
        if not is_sha256_hex(candidate_thread):
            raise ReconstructionError("thread-binding-invalid")
        if thread_hash is None:
            thread_hash = candidate_thread
        elif candidate_thread != thread_hash:
            raise ReconstructionError("thread-binding-changed")

        result_hash = metadata.get("accepted_result_hash")
        if not is_sha256_hex(result_hash):
            raise ReconstructionError("result-binding-invalid")
        result_hashes.append(result_hash)

        if metadata.get("terminal_result_count") != 1:
            raise ReconstructionError("terminal-result-count-invalid")
        if metadata.get("completion_receipt") is not True:
            raise ReconstructionError("completion-receipt-missing")
        # "is not False" rather than "is True": a missing field must fail, not pass as falsy.
        if metadata.get("cache_used") is not False:
            raise ReconstructionError("cache-use-not-proven-false")
        if metadata.get("quarantined_request_retried") is not False:
            raise ReconstructionError("quarantine-retry-not-proven-false")

        process_marker_hash = metadata.get("process_marker_hash")
        if not is_sha256_hex(process_marker_hash):
            raise ReconstructionError("process-marker-binding-invalid")
        process_marker_hashes.append(process_marker_hash)

    # Turn 3 must have run in a different process than turns 1 and 2, otherwise the "restart"
    # proves nothing: in-memory state could have carried over.
    if process_marker_hashes[2] in process_marker_hashes[:2]:
        raise ReconstructionError("turn-three-process-not-distinct")

    assert thread_hash is not None  # three rows were checked, so the first one set it
    state_digest = _digest(
        {
            "thread_id_hash": thread_hash,
            "accepted_result_hashes": result_hashes,
        }
    )
    return {
        "schema": RECEIPT_SCHEMA,
        "ok": True,
        "turn_count": 3,
        "thread_id_hash": thread_hash,
        "turn_three_process_distinct": True,
        "terminal_result_count_each": 1,
        "completion_receipts_present": True,
        "cache_used": False,
        "quarantined_request_retried": False,
        "state_digest": state_digest,
        "ledger_entries": chain.entries,
    }


def verify_pass_k(path: str | Path, *, k: int = 3) -> dict[str, Any]:
    """Require ``k`` identical reconstructions from the same chain.

    Each pass re-reads and re-verifies the file, so nothing is cached between passes. Identical
    receipts show the result is a function of the ledger bytes alone.

    Args:
        path: Ledger file holding the proof entries.
        k: Number of passes, at least 1.

    Returns:
        The first receipt, extended with ``pass_count`` and ``pass_k``.

    Raises:
        ReconstructionError: ``k`` is invalid, a pass fails, or the passes disagree.
    """
    if not isinstance(k, int) or isinstance(k, bool) or k < 1:
        raise ReconstructionError("pass-count-invalid")
    receipts = [reconstruct(path) for _ in range(k)]
    canonical = [json.dumps(row, sort_keys=True, separators=(",", ":")) for row in receipts]
    if len(set(canonical)) != 1:
        raise ReconstructionError("reconstruction-nondeterministic")
    result = dict(receipts[0])
    result["pass_count"] = k
    result["pass_k"] = True
    return result
