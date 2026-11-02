"""The pinned readiness gate, replay ledger strictness and reason-code hygiene."""

from __future__ import annotations

import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from alcor_computer.contracts import sha256_hex
from alcor_computer.readlane_adapter import READ_SCOPE_CONTRACT_SHA256_PREFIX
from alcor_computer.secure_mediator import ComputerUseMediator, ReplayLedger
from alcor_computer.selftest import NOW_MS, READ_SCOPE_PREFIX, fixture


def secure_mediator(ledger: ReplayLedger | None = None) -> ComputerUseMediator:
    return ComputerUseMediator(
        read_scope_contract_sha256_prefix=READ_SCOPE_PREFIX,
        read_chain_verifier=lambda _chain, _digest: True,
        read_scope_binding_valid=True,
        read_scope_contract_frozen_green=True,
        replay_ledger=ledger or ReplayLedger(),
        now_ms=lambda: NOW_MS,
    )


def write_binding(root: Path, *, prefix: str | None = READ_SCOPE_CONTRACT_SHA256_PREFIX) -> None:
    contracts = root / "alcor_computer" / "contracts"
    contracts.mkdir(parents=True, exist_ok=True)
    (contracts / "alcor_read_scope_binding_v1.json").write_text(
        json.dumps(
            {
                "schema": "alcor.computer.read-scope-binding.v1",
                "contract_sha256_prefix": prefix,
                "frozen": prefix is not None,
                "independently_green": prefix is not None,
            }
        ),
        encoding="utf-8",
    )


class SecureMediatorTests(unittest.TestCase):
    def test_public_mediator_accepts_once_and_rejects_fresh_nonce_replay(self) -> None:
        med = secure_mediator()
        chain, bundle = fixture()
        first = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
        replay = deepcopy(bundle)
        replay["nonce"] = "bundle-nonce-000002"
        second = med.stage_json_pair(json.dumps(chain), json.dumps(replay))
        self.assertTrue(first["accepted"])
        self.assertFalse(first["input_fired"])
        self.assertEqual(second["reason_code"], "replay")

    def test_environment_and_hash_file_cannot_self_authorize(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_binding(root)
            chain, bundle = fixture()
            registry = (
                root / ".local-state" / "alcor-read-scope" / "authenticated-read-chains-v1.txt"
            )
            registry.parent.mkdir(parents=True)
            registry.write_text(sha256_hex(chain) + "\n", encoding="ascii")
            with patch.dict(
                "os.environ",
                {"ALCOR_READ_SCOPE_CONTRACT_SHA256_PREFIX": READ_SCOPE_PREFIX},
                clear=False,
            ):
                med = ComputerUseMediator.for_repo(root)
            med.now_ms = lambda: NOW_MS
            status = med.status()
            self.assertTrue(status["read_scope_binding_valid"])
            self.assertTrue(status["read_scope_contract_frozen_green"])
            self.assertTrue(status["read_scope_verifier_available"])
            self.assertTrue(status["validation_ready"])
            receipt = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
            self.assertEqual(receipt["reason_code"], "forged_observe_click")
            self.assertFalse(receipt["input_fired"])

    def test_missing_binding_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            med = ComputerUseMediator.for_repo(Path(temporary))
            chain, bundle = fixture()
            self.assertFalse(med.status()["read_scope_binding_valid"])
            self.assertEqual(
                med.stage_json_pair(json.dumps(chain), json.dumps(bundle))["reason_code"],
                "read_scope_binding_invalid",
            )

    def test_wrong_contract_pin_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_binding(root, prefix="0" * 12)
            med = ComputerUseMediator.for_repo(root)
            chain, bundle = fixture()
            status = med.status()
            self.assertFalse(status["read_scope_binding_valid"])
            self.assertFalse(status["read_scope_contract_frozen_green"])
            self.assertFalse(status["read_scope_verifier_available"])
            self.assertEqual(
                med.stage_json_pair(json.dumps(chain), json.dumps(bundle))["reason_code"],
                "read_scope_binding_invalid",
            )

    def test_empty_partial_duplicate_or_unsorted_replay_ledger_fails_closed(self) -> None:
        invalid_ledgers = (
            "",
            "0" * 64,
            ("0" * 64 + "\n") * 2,
            "f" * 64 + "\n" + "0" * 64 + "\n",
        )
        with tempfile.TemporaryDirectory() as temporary:
            ledger_path = Path(temporary) / "consumed.txt"
            chain, bundle = fixture()
            for raw in invalid_ledgers:
                with self.subTest(raw_length=len(raw)):
                    ledger_path.write_text(raw, encoding="ascii")
                    receipt = secure_mediator(ReplayLedger(ledger_path)).stage_json_pair(
                        json.dumps(chain),
                        json.dumps(bundle),
                    )
                    self.assertEqual(receipt["reason_code"], "replay_store_invalid")

    def test_reason_codes_cannot_echo_exception_or_payload_text(self) -> None:
        receipt = secure_mediator().reject_receipt("payload-or-secret-text")
        self.assertEqual(receipt["reason_code"], "internal_error")
        self.assertNotIn("secret", json.dumps(receipt))


if __name__ == "__main__":
    unittest.main()
