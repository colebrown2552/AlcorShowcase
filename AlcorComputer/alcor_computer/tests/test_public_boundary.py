"""Malformed input and store failures become sanitised receipts."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from alcor_computer.mediator import ComputerUseMediator, ReplayLedger
from alcor_computer.selftest import NOW_MS, READ_SCOPE_PREFIX, fixture


def mediator_with(ledger: ReplayLedger | None = None) -> ComputerUseMediator:
    return ComputerUseMediator(
        read_scope_contract_sha256_prefix=READ_SCOPE_PREFIX,
        read_chain_verifier=lambda _chain, _digest: True,
        read_scope_binding_valid=True,
        read_scope_contract_frozen_green=True,
        replay_ledger=ledger or ReplayLedger(),
        now_ms=lambda: NOW_MS,
    )


class PublicBoundaryTests(unittest.TestCase):
    def test_lone_surrogate_is_a_sanitized_invalid_json_receipt(self) -> None:
        _chain, bundle = fixture()
        raw = "\ud800"
        for method_name in ("validate_json_pair", "stage_json_pair"):
            with self.subTest(method=method_name):
                receipt = getattr(mediator_with(), method_name)(raw, json.dumps(bundle))
                self.assertEqual(receipt["reason_code"], "invalid_json")
                self.assertFalse(receipt["accepted"])
                self.assertNotIn(raw, json.dumps(receipt))

    def test_obstructed_replay_parent_is_sanitized(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            blocked = root / "blocked"
            blocked.write_text("not-a-directory", encoding="utf-8")
            chain, bundle = fixture()
            receipt = mediator_with(ReplayLedger(blocked / "consumed.txt")).stage_json_pair(
                json.dumps(chain),
                json.dumps(bundle),
            )
            serialized = json.dumps(receipt)
            self.assertEqual(receipt["reason_code"], "replay_store_unavailable")
            self.assertFalse(receipt["accepted"])
            self.assertNotIn(str(root), serialized)
            self.assertNotIn("blocked", serialized)


if __name__ == "__main__":
    unittest.main()
