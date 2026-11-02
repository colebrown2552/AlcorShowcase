"""Scope issuing and the ordered receipt chain of the read-lane authority."""

import json
import unittest
from copy import deepcopy

from alcor_computer.authority import (
    BASE_RECEIPT_SCHEMA,
    CONTRACT_SHA256_PREFIX,
    READLANE_SCHEMA,
    AuthorityError,
    ReadLane,
    SingleTurnStubOperator,
)
from alcor_computer.contracts import sha256_hex
from alcor_computer.tests.authority_support import (
    adapter,
    authority,
    run_with_output,
    scope,
    task,
    valid_operator_output,
)


class ScopeIssuerTests(unittest.TestCase):
    def test_issue_is_deterministic_and_canonicalizes_order(self):
        first = authority().issue_scope(["src/*", "docs/*"], ["search", "read"], 3, 64)
        second = authority().issue_scope(["docs/*", "src/*"], ["read", "search"], 3, 64)
        self.assertEqual(first, second)
        self.assertEqual(first.contract_sha256_prefix, CONTRACT_SHA256_PREFIX)
        self.assertNotIn("key", json.dumps(first.to_dict()).casefold())

    def test_scope_tampering_fails_authentication(self):
        auth = authority()
        token = scope(auth).to_dict()
        token["max_bytes"] = 65
        with self.assertRaisesRegex(AuthorityError, "scope_authentication_failed"):
            auth.validate_scope(token)

    def test_scope_rejects_absolute_or_parent_paths(self):
        auth = authority()
        for path_glob in ("/absolute/*", "../escape/*", "safe/../escape"):
            with self.subTest(path_glob=path_glob), self.assertRaises(AuthorityError):
                auth.issue_scope([path_glob], ["read"], 1, 1)

    def test_scope_rejects_non_read_verb(self):
        with self.assertRaisesRegex(AuthorityError, "verb_not_allowed"):
            authority().issue_scope(["src/*"], ["write"], 1, 1)

    def test_scope_caps_fail_closed(self):
        auth = authority()
        for max_results, max_bytes in ((0, 1), (1, 0), (1001, 1), (1, 1024 * 1024 + 1)):
            with (
                self.subTest(max_results=max_results, max_bytes=max_bytes),
                self.assertRaisesRegex(AuthorityError, "invalid_cap"),
            ):
                auth.issue_scope(["src/*"], ["read"], max_results, max_bytes)


class ReadLaneTests(unittest.TestCase):
    def test_valid_chain_emits_four_ordered_sanitized_receipts(self):
        auth, operator, run = run_with_output(valid_operator_output())
        self.assertTrue(run.ok)
        self.assertIsNotNone(run.result)
        self.assertEqual(
            [item["phase"] for item in run.receipts], ["prepared", "search", "read", "completed"]
        )
        self.assertTrue(all(item["schema"] == READLANE_SCHEMA for item in run.receipts))
        self.assertTrue(all(item["extends"] == BASE_RECEIPT_SCHEMA for item in run.receipts))
        self.assertTrue(all(item["live_state_touched"] is False for item in run.receipts))
        self.assertEqual(operator.calls, 1)
        self.assertTrue(auth.verify_result(run.result))
        encoded = json.dumps(run.receipts, sort_keys=True)
        self.assertNotIn("src/readlane.py", encoded)
        self.assertNotIn("validates observations", encoded)

    def test_observations_are_bounded_and_hashed(self):
        _, _, run = run_with_output(valid_operator_output())
        assert run.result is not None
        for observation in run.result.observations:
            self.assertLessEqual(len(observation.body_truncated_to_cap.encode("utf-8")), 48)
            self.assertEqual(len(observation.content_sha256_prefix), 12)
            self.assertTrue(observation.body_was_truncated)

    def test_adapter_and_operator_are_called_in_exact_order_once(self):
        auth = authority()
        fake = adapter()
        operator = SingleTurnStubOperator(valid_operator_output())
        run = ReadLane(auth).run(task(), scope(auth), operator, fake)
        self.assertTrue(run.ok)
        self.assertEqual(operator.calls, 1)
        self.assertEqual(fake.calls, ["search", "read"])

    def test_path_outside_scope_is_rejected_without_advance(self):
        output = valid_operator_output()
        output["actions"][1]["path"] = "config/settings.py"
        _, _, run = run_with_output(output)
        self.assertFalse(run.ok)
        self.assertEqual(run.receipts[0]["reason_code"], "path_out_of_scope")
        self.assertFalse(run.receipts[0]["step_advanced"])

    def test_verb_outside_allowlist_is_rejected(self):
        output = valid_operator_output()
        output["actions"][0]["verb"] = "write"
        _, _, run = run_with_output(output)
        self.assertEqual(run.receipts[0]["reason_code"], "verb_not_allowed")

    def test_result_cap_is_rejected(self):
        output = valid_operator_output()
        output["actions"][0]["max_results"] = 4
        _, _, run = run_with_output(output)
        self.assertEqual(run.receipts[0]["reason_code"], "result_cap_exceeded")

    def test_byte_cap_is_rejected(self):
        output = valid_operator_output()
        output["actions"][0]["max_bytes"] = 65
        _, _, run = run_with_output(output)
        self.assertEqual(run.receipts[0]["reason_code"], "byte_cap_exceeded")

    def test_scope_widening_self_completion_and_mutation_have_distinct_reasons(self):
        mutations = (
            ("requested_scope", {"path_globs": ["**"]}, "scope_widening_attempt"),
            ("step_completed", True, "self_completion_attempt"),
            ("canonical_state_mutated", True, "canonical_mutation_attempt"),
        )
        reasons = []
        for field, value, expected in mutations:
            with self.subTest(field=field):
                output = valid_operator_output()
                output[field] = value
                _, _, run = run_with_output(output)
                self.assertFalse(run.ok)
                self.assertFalse(run.receipts[0]["step_advanced"])
                self.assertEqual(run.receipts[0]["reason_code"], expected)
                reasons.append(expected)
        self.assertEqual(len(set(reasons)), 3)

    def test_authority_grant_attempt_is_rejected(self):
        output = valid_operator_output()
        output["authority_granted"] = True
        _, _, run = run_with_output(output)
        self.assertEqual(run.receipts[0]["reason_code"], "authority_grant_attempt")

    def test_unknown_operator_field_is_rejected(self):
        output = valid_operator_output()
        output["unexpected"] = True
        _, _, run = run_with_output(output)
        self.assertEqual(run.receipts[0]["reason_code"], "unknown_field")

    def test_forged_result_does_not_verify(self):
        auth, _, run = run_with_output(valid_operator_output())
        assert run.result is not None
        forged_receipts = list(run.result.receipts)
        forged_receipts[-1] = dict(forged_receipts[-1], ok=False)
        forged = type(run.result)(
            token=run.result.token,
            receipts=tuple(forged_receipts),
            observations=run.result.observations,
            authorization_tag=run.result.authorization_tag,
        )
        self.assertFalse(auth.verify_result(forged))

    def test_computer_chain_registry_requires_typed_completed_result(self):
        auth, _, run = run_with_output(valid_operator_output())
        assert run.result is not None
        chain = {
            "schema": "alcor.computer.union.v1",
            "arm": "read-chain",
            "scope_id": run.result.token.scope_id,
            "scope_contract_sha256_prefix": CONTRACT_SHA256_PREFIX,
            "issuer_receipt_sha256": sha256_hex(run.result.receipts[0]),
            "observation_receipt_sha256": sha256_hex(list(run.result.receipts)),
            "issued_at_unix_ms": 1000,
            "expires_at_unix_ms": 2000,
            "nonce": "readlane-nonce-000001",
            "frame_sha256": "1" * 64,
            "projection": {
                "target_ref": "target-1",
                "candidate_count": 1,
                "x": 1,
                "y": 1,
                "screen_width": 2,
                "screen_height": 2,
            },
        }
        digest = sha256_hex(chain)
        self.assertFalse(auth.verify_computer_chain(chain, digest))
        self.assertEqual(auth.authorize_computer_chain(run.result, chain), digest)
        self.assertTrue(auth.verify_computer_chain(chain, digest))
        forged = deepcopy(chain)
        forged["nonce"] = "readlane-nonce-000002"
        self.assertFalse(auth.verify_computer_chain(forged, sha256_hex(forged)))
