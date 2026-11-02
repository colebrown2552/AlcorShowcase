"""Three-turn reconstruction: determinism, each invariant failing closed, tamper rejection."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from continuity_core.ledger import JsonlLedger
from continuity_core.reconstruct import (
    PROOF_SCHEMA,
    PROOF_TAG,
    ReconstructionError,
    reconstruct,
    verify_pass_k,
)

COMPONENT_ROOT = Path(__file__).resolve().parents[1]
SRC = COMPONENT_ROOT / "src"


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class ThreeTurnReconstructionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "continuity.jsonl"

    def build(self, changes: dict[int, dict[str, object]] | None = None) -> None:
        ledger = JsonlLedger(self.path)
        thread_hash = sha("synthetic-thread")
        for index in range(1, 4):
            metadata: dict[str, object] = {
                "proof_schema": PROOF_SCHEMA,
                "thread_id_hash": thread_hash,
                "turn_index": index,
                "accepted_result_hash": sha(f"result-{index}"),
                "terminal_result_count": 1,
                "completion_receipt": True,
                "cache_used": False,
                "quarantined_request_retried": False,
                "process_marker_hash": sha("process-b" if index == 3 else "process-a"),
            }
            if changes and index in changes:
                metadata.update(changes[index])
            ledger.append(
                {
                    "id": f"continuity-proof-{index}",
                    "kind": "observation",
                    "status": "confirmed",
                    "statement": f"Synthetic continuity proof turn {index} accepted",
                    "confidence": 1.0,
                    "provenance": {"type": "test"},
                    "tags": [PROOF_TAG],
                    "metadata": metadata,
                    "created_at": f"2026-08-13T10:0{index}:00Z",
                }
            )

    def test_pass_three_is_deterministic_and_cache_free(self) -> None:
        self.build()
        first = verify_pass_k(self.path, k=3)
        second = verify_pass_k(self.path, k=3)
        self.assertTrue(first["ok"])
        self.assertTrue(first["pass_k"])
        self.assertEqual(first["pass_count"], 3)
        self.assertEqual(first["turn_count"], 3)
        self.assertFalse(first["cache_used"])
        self.assertFalse(first["quarantined_request_retried"])
        self.assertEqual(first["state_digest"], second["state_digest"])

    def test_turn_three_requires_distinct_process_marker(self) -> None:
        self.build({3: {"process_marker_hash": sha("process-a")}})
        with self.assertRaisesRegex(ReconstructionError, "turn-three-process-not-distinct"):
            reconstruct(self.path)

    def test_process_marker_must_be_hash_bound(self) -> None:
        self.build({3: {"process_marker_hash": "process-b"}})
        with self.assertRaisesRegex(ReconstructionError, "process-marker-binding-invalid"):
            reconstruct(self.path)

    def test_exactly_one_terminal_result_per_turn(self) -> None:
        self.build({2: {"terminal_result_count": 2}})
        with self.assertRaisesRegex(ReconstructionError, "terminal-result-count-invalid"):
            reconstruct(self.path)

    def test_completion_receipt_is_required(self) -> None:
        self.build({2: {"completion_receipt": False}})
        with self.assertRaisesRegex(ReconstructionError, "completion-receipt-missing"):
            reconstruct(self.path)

    def test_cache_use_fails_closed(self) -> None:
        self.build({1: {"cache_used": True}})
        with self.assertRaisesRegex(ReconstructionError, "cache-use-not-proven-false"):
            reconstruct(self.path)

    def test_quarantined_request_retry_fails_closed(self) -> None:
        self.build({2: {"quarantined_request_retried": True}})
        with self.assertRaisesRegex(ReconstructionError, "quarantine-retry-not-proven-false"):
            reconstruct(self.path)

    def test_thread_binding_must_remain_stable(self) -> None:
        self.build({3: {"thread_id_hash": sha("different-thread")}})
        with self.assertRaisesRegex(ReconstructionError, "thread-binding-changed"):
            reconstruct(self.path)

    def test_hash_chain_tamper_is_rejected_before_reconstruction(self) -> None:
        self.build()
        text = self.path.read_text(encoding="utf-8")
        self.path.write_text(
            text.replace(
                "Synthetic continuity proof turn 2 accepted",
                "Synthetic continuity proof turn 2 changed",
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ReconstructionError, "ledger-chain-invalid"):
            reconstruct(self.path)

    def test_fresh_python_process_reconstructs_same_state_from_chain(self) -> None:
        self.build()
        expected = reconstruct(self.path)["state_digest"]
        env = dict(os.environ)
        env["PYTHONPATH"] = str(SRC) + os.pathsep + env.get("PYTHONPATH", "")
        program = (
            "import json,sys; "
            "from continuity_core.reconstruct import verify_pass_k; "
            "print(json.dumps(verify_pass_k(sys.argv[1], k=3), sort_keys=True))"
        )
        proc = subprocess.run(
            [sys.executable, "-B", "-c", program, str(self.path)],
            cwd=str(COMPONENT_ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        receipt = json.loads(proc.stdout)
        self.assertEqual(receipt["state_digest"], expected)
        self.assertEqual(receipt["pass_count"], 3)
        self.assertTrue(receipt["turn_three_process_distinct"])


if __name__ == "__main__":
    unittest.main()
