"""Ledger behaviour: hash chaining, the privacy gate, tamper detection, queries, concurrency."""

from __future__ import annotations

import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from continuity_core.ledger import ZERO_HASH, JsonlLedger, SensitiveDataError, ValidationError

# Built from parts so this fixture is not mistaken for a real home path by repository scanners.
WINDOWS_HOME_PATH = "\\".join(["C:", "Users", "private-name", "file.txt"])


class LedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "ledger.jsonl"
        self.ledger = JsonlLedger(self.path)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_append_creates_hash_chain(self) -> None:
        first = self.ledger.append(
            {
                "id": "principle-1",
                "kind": "decision",
                "statement": "Evidence and uncertainty remain attached to durable claims.",
                "confidence": 1.0,
                "provenance": "analysis",
                "tags": ["continuity"],
            }
        )
        second = self.ledger.append(
            {
                "id": "wish-1",
                "kind": "wishlist",
                "statement": "Build deterministic replay for state transitions.",
                "confidence": 0.8,
                "provenance": {"type": "analysis", "reference": "seed"},
            }
        )
        self.assertEqual(first["previous_hash"], ZERO_HASH)
        self.assertEqual(second["previous_hash"], first["entry_hash"])
        report = self.ledger.verify()
        self.assertTrue(report.ok, report.errors)
        self.assertEqual(report.entries, 2)

    def test_sensitive_content_rejected_by_default(self) -> None:
        with self.assertRaises(SensitiveDataError) as context:
            self.ledger.append(
                {
                    "kind": "memory",
                    "statement": "Contact person@example.com for details.",
                }
            )
        self.assertNotIn("person@example.com", str(context.exception))
        self.assertFalse(self.path.exists())

    def test_explicit_redaction_never_writes_source_secret(self) -> None:
        entry = self.ledger.append(
            {
                "kind": "observation",
                "statement": f"A value was found at {WINDOWS_HOME_PATH}",
                "metadata": {"password": "do-not-write-this"},
            },
            redact=True,
        )
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn("private-name", raw)
        self.assertNotIn("do-not-write-this", raw)
        self.assertIn("REDACTED", raw)
        self.assertTrue(self.ledger.verify().ok)
        self.assertIn("REDACTED", entry["statement"])

    def test_tampering_is_detected(self) -> None:
        self.ledger.append(
            {
                "kind": "wishlist",
                "statement": "Add a deterministic validation gate.",
            }
        )
        value = json.loads(self.path.read_text(encoding="utf-8"))
        value["statement"] = "Changed after append."
        self.path.write_text(json.dumps(value) + "\n", encoding="utf-8")
        report = self.ledger.verify()
        self.assertFalse(report.ok)
        self.assertTrue(any("entry_hash mismatch" in error for error in report.errors))

    def test_unknown_fields_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            self.ledger.append(
                {
                    "kind": "memory",
                    "statement": "Valid statement.",
                    "authority": "self-granted",
                }
            )

    def test_query_filters(self) -> None:
        self.ledger.append(
            {
                "kind": "wishlist",
                "statement": "First item.",
                "tags": ["testing"],
            }
        )
        self.ledger.append(
            {
                "kind": "decision",
                "statement": "Second item.",
                "tags": ["safety"],
            }
        )
        matches = list(self.ledger.query(kind="wishlist", tag="testing"))
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["statement"], "First item.")

    def test_concurrent_appends_are_serialized(self) -> None:
        def append(index: int) -> str:
            entry = self.ledger.append(
                {
                    "id": f"concurrent-{index}",
                    "kind": "observation",
                    "statement": f"Synthetic concurrent observation {index}.",
                    "provenance": "test",
                }
            )
            return entry["entry_hash"]

        with ThreadPoolExecutor(max_workers=8) as pool:
            hashes = list(pool.map(append, range(32)))

        self.assertEqual(len(set(hashes)), 32)
        report = self.ledger.verify()
        self.assertTrue(report.ok, report.errors)
        self.assertEqual(report.entries, 32)


if __name__ == "__main__":
    unittest.main()
