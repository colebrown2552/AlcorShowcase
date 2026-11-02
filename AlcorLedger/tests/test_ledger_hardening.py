"""Ledger hardening: damaged ledgers are never extended, ids are unique, fields are closed."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from continuity_core.ledger import ChainError, JsonlLedger, ValidationError


class LedgerHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "ledger.jsonl"
        self.ledger = JsonlLedger(self.path)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_append_refuses_a_corrupted_existing_ledger(self) -> None:
        self.ledger.append(
            {
                "id": "stable-id",
                "kind": "memory",
                "statement": "A synthetic durable claim.",
            }
        )
        value = json.loads(self.path.read_text(encoding="utf-8"))
        value["statement"] = "Mutated without rebuilding the hash."
        self.path.write_text(json.dumps(value) + "\n", encoding="utf-8")
        before = self.path.read_bytes()

        with self.assertRaises(ChainError):
            self.ledger.append(
                {
                    "id": "new-id",
                    "kind": "memory",
                    "statement": "This must not be appended.",
                }
            )

        self.assertEqual(self.path.read_bytes(), before)

    def test_duplicate_identifier_is_rejected_without_mutation(self) -> None:
        source = {
            "id": "stable-id",
            "kind": "decision",
            "statement": "A synthetic decision.",
        }
        self.ledger.append(source)
        before = self.path.read_bytes()

        with self.assertRaises(ValidationError):
            self.ledger.append(source)

        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(self.ledger.verify().ok)

    def test_unknown_stored_fields_are_reported(self) -> None:
        self.ledger.append(
            {
                "id": "stable-id",
                "kind": "memory",
                "statement": "A synthetic durable claim.",
            }
        )
        value = json.loads(self.path.read_text(encoding="utf-8"))
        value["undeclared"] = "synthetic"
        value_without_hash = dict(value)
        value_without_hash.pop("entry_hash")
        encoded = json.dumps(
            value_without_hash,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        value["entry_hash"] = hashlib.sha256(encoded).hexdigest()
        self.path.write_text(json.dumps(value) + "\n", encoding="utf-8")

        report = self.ledger.verify()
        self.assertFalse(report.ok)
        self.assertTrue(
            any("unsupported stored fields" in error for error in report.errors),
            report.errors,
        )


if __name__ == "__main__":
    unittest.main()
