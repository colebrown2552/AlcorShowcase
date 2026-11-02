"""Contract shape, adversarial refusals and the green path of the public mediator."""

from __future__ import annotations

import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from alcor_computer.contracts import (
    COMPUTER_BUNDLE_ARM,
    READ_CHAIN_ARM,
    STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
    load_union_schema,
    sha256_hex,
)
from alcor_computer.mediator import ComputerUseMediator, ReplayLedger
from alcor_computer.selftest import NOW_MS, READ_SCOPE_PREFIX, fixture, mediator, run


class ContractShapeTests(unittest.TestCase):
    def test_union_has_exactly_two_closed_arms(self) -> None:
        schema = load_union_schema()
        refs = [entry["$ref"] for entry in schema["oneOf"]]
        self.assertEqual(refs, ["#/$defs/read-chain", "#/$defs/computer bundle"])
        self.assertEqual(
            schema["$defs"]["read-chain"]["properties"]["arm"]["const"], READ_CHAIN_ARM
        )
        self.assertEqual(
            schema["$defs"]["computer bundle"]["properties"]["arm"]["const"],
            COMPUTER_BUNDLE_ARM,
        )
        self.assertFalse(schema["$defs"]["read-chain"]["additionalProperties"])
        self.assertFalse(schema["$defs"]["computer bundle"]["additionalProperties"])
        self.assertFalse(schema["$defs"]["projection"]["additionalProperties"])
        self.assertFalse(schema["$defs"]["action"]["additionalProperties"])

    def test_unknown_fields_and_duplicate_keys_reject(self) -> None:
        med = mediator()
        chain, bundle = fixture()
        chain["surprise"] = True
        receipt = med.validate_json_pair(json.dumps(chain), json.dumps(bundle))
        self.assertEqual(receipt["reason_code"], "unknown_field")
        raw = '{"schema":"alcor.computer.union.v1","schema":"duplicate"}'
        receipt = med.validate_json_pair(raw, json.dumps(bundle))
        self.assertEqual(receipt["reason_code"], "duplicate_key")


class AdversarialRedTests(unittest.TestCase):
    def test_forged_observe_to_click_rejects(self) -> None:
        med = mediator()
        chain, bundle = fixture()
        chain["issuer_receipt_sha256"] = "9" * 64
        bundle["read_chain_sha256"] = sha256_hex(chain)
        receipt = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
        self.assertTrue(receipt["rejected"])
        self.assertEqual(receipt["reason_code"], "forged_observe_click")
        self.assertNotIn("scope_id", receipt)
        self.assertNotIn("target_ref", receipt)

    def test_stale_scope_rejects(self) -> None:
        med = mediator()
        chain, bundle = fixture()
        chain["expires_at_unix_ms"] = NOW_MS
        bundle["read_chain_sha256"] = sha256_hex(chain)
        receipt = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
        self.assertEqual(receipt["reason_code"], "stale_scope")

    def test_projection_failure_and_ambiguity_reject(self) -> None:
        med = mediator()
        chain, bundle = fixture()
        chain["projection"]["candidate_count"] = 2
        bundle["read_chain_sha256"] = sha256_hex(chain)
        receipt = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
        self.assertEqual(receipt["reason_code"], "projection_failure")

    def test_replay_rejects_after_consume_before_act(self) -> None:
        med = mediator()
        chain, bundle = fixture()
        first = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
        replay_bundle = deepcopy(bundle)
        replay_bundle["nonce"] = "bundle-nonce-000002"
        second = med.stage_json_pair(json.dumps(chain), json.dumps(replay_bundle))
        self.assertTrue(first["accepted"])
        self.assertTrue(first["replay_recorded"])
        self.assertFalse(first["input_fired"])
        self.assertEqual(second["reason_code"], "replay")


class GreenAndBoundaryTests(unittest.TestCase):
    def test_valid_chain_is_accepted_without_input(self) -> None:
        med = mediator()
        chain, bundle = fixture()
        receipt = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
        self.assertTrue(receipt["accepted"])
        self.assertEqual(receipt["reason_code"], "staged_no_input")
        self.assertFalse(receipt["owner_gated"])
        self.assertFalse(receipt["input_fired"])
        self.assertFalse(receipt["desktop_state_touched"])

    def test_default_repo_plugin_fails_closed_until_read_contract_exists(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            med = ComputerUseMediator.for_repo(Path(temporary))
            chain, bundle = fixture()
            receipt = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
            self.assertEqual(receipt["reason_code"], "read_scope_contract_unavailable")
            self.assertFalse(med.status()["read_scope_contract_frozen_green"])

    def test_bundle_is_bound_to_frozen_mediator_hash(self) -> None:
        med = mediator()
        chain, bundle = fixture()
        bundle["mediator_contract_sha256_prefix"] = "0" * 12
        receipt = med.validate_json_pair(json.dumps(chain), json.dumps(bundle))
        self.assertEqual(receipt["reason_code"], "mediator_contract_mismatch")
        self.assertNotEqual(STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX, "0" * 12)

    def test_persistent_replay_ledger_survives_reinstantiation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            ledger_path = Path(temporary) / "consumed.txt"
            chain, bundle = fixture()

            def verify(_: object, __: str) -> bool:
                return True

            first = ComputerUseMediator(
                read_scope_contract_sha256_prefix=READ_SCOPE_PREFIX,
                read_chain_verifier=verify,
                replay_ledger=ReplayLedger(ledger_path),
                now_ms=lambda: NOW_MS,
            )
            self.assertTrue(
                first.stage_json_pair(json.dumps(chain), json.dumps(bundle))["accepted"]
            )
            second = ComputerUseMediator(
                read_scope_contract_sha256_prefix=READ_SCOPE_PREFIX,
                read_chain_verifier=verify,
                replay_ledger=ReplayLedger(ledger_path),
                now_ms=lambda: NOW_MS,
            )
            self.assertEqual(
                second.stage_json_pair(json.dumps(chain), json.dumps(bundle))["reason_code"],
                "replay",
            )

    def test_selftest_emits_four_reds_one_green_and_static_no_input(self) -> None:
        receipt = run()
        self.assertEqual(receipt["red_suite"]["passed"], 4)
        self.assertEqual(receipt["green_suite"]["passed"], 1)
        self.assertTrue(receipt["no_owner_gated_input"]["ok"])
        self.assertTrue(receipt["read_scope_contract_frozen_green"])
        self.assertTrue(receipt["read_scope_source_verification"]["ok"])
        self.assertTrue(receipt["ok"])


if __name__ == "__main__":
    unittest.main()
