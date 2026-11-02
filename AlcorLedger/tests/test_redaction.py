"""Redaction: findings never expose the match, redaction is rescannable, odd files are skipped."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from continuity_core.redaction import redact_text, redact_value, scan_file, scan_text, scan_value

# Synthetic value. It is joined to "Bearer" inside an f-string so that secret scanners reading
# this file do not mistake the fixture for a real bearer credential.
FAKE_TOKEN = "abcdefghijklmnopqrstuvwxyz"


class RedactionTests(unittest.TestCase):
    def test_findings_do_not_expose_match(self) -> None:
        address = "person@example.com"
        findings = scan_text(f"contact {address}")
        self.assertEqual(len(findings), 1)
        finding = findings[0]
        self.assertEqual(finding.label, "email")
        self.assertNotIn(address, json.dumps(finding.as_dict()))
        self.assertEqual(finding.length, len(address))

    def test_redact_overlapping_sensitive_values(self) -> None:
        original = f"Bearer {FAKE_TOKEN}"
        redacted, findings = redact_text(original)
        self.assertTrue(findings)
        self.assertNotIn(FAKE_TOKEN, redacted)
        self.assertIn("<REDACTED:BEARER-TOKEN>", redacted)

    def test_recursive_sensitive_key_redaction_is_rescannable(self) -> None:
        value = {"metadata": {"api_key": "not-safe-at-all"}}
        findings = scan_value(value)
        self.assertTrue(findings)
        clean, redactions = redact_value(value)
        self.assertTrue(redactions)
        self.assertEqual(scan_value(clean), ())
        self.assertTrue(clean["metadata"]["api_key"].startswith("<REDACTED:SENSITIVE-KEY:"))

    def test_person_and_machine_keys_are_blocked(self) -> None:
        value = {"metadata": {"username": "example", "device_id": "opaque-value"}}
        labels = {finding.label for finding in scan_value(value)}
        self.assertIn("sensitive-key:username", labels)
        self.assertIn("sensitive-key:device_id", labels)

    def test_json_file_detects_sensitive_keys_without_echo(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "entry.json"
            path.write_text('{"token":"very-sensitive-value"}', encoding="utf-8")
            result = scan_file(path)
            self.assertTrue(result.findings)
            serialized = json.dumps([finding.as_dict() for finding in result.findings])
            self.assertNotIn("very-sensitive-value", serialized)

    def test_binary_file_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.txt"
            path.write_bytes(b"hello\x00world")
            result = scan_file(path)
            self.assertTrue(result.skipped)
            self.assertEqual(result.reason, "binary")


if __name__ == "__main__":
    unittest.main()
