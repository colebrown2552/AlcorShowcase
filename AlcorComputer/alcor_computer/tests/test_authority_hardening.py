"""Result and chain hardening, caps, and the authority's static verifier."""

import hashlib
import unittest
from pathlib import Path

from alcor_computer.authority import (
    CONTRACT_SHA256_PREFIX,
    AuthorityError,
    BoundedObservation,
    FakeObservationAdapter,
    ReadLane,
    SingleTurnStubOperator,
    static_check,
)
from alcor_computer.authority.contract import CONTRACT, MAX_SCOPE_BYTES
from alcor_computer.authority.static_check import RUNTIME_MODULES, verify_source_contract
from alcor_computer.contracts import canonical_bytes, sha256_hex
from alcor_computer.tests.authority_support import (
    adapter,
    authority,
    run_with_output,
    scope,
    task,
    valid_operator_output,
)


def computer_chain(result):
    return {
        "schema": "alcor.computer.union.v1",
        "arm": "read-chain",
        "scope_id": result.token.scope_id,
        "scope_contract_sha256_prefix": CONTRACT_SHA256_PREFIX,
        "issuer_receipt_sha256": sha256_hex(result.receipts[0]),
        "observation_receipt_sha256": sha256_hex(list(result.receipts)),
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


class ResultBoundaryTests(unittest.TestCase):
    def test_result_authorization_rejects_extra_receipt_fields(self):
        auth, _, run = run_with_output(valid_operator_output())
        assert run.result is not None
        receipts = [dict(item) for item in run.result.receipts]
        receipts[1]["path"] = "not-public"
        with self.assertRaisesRegex(AuthorityError, "readlane_result_invalid"):
            auth.authorize_result(run.result.token, receipts, run.result.observations)

    def test_result_authorization_rejects_oversized_observation(self):
        auth, _, run = run_with_output(valid_operator_output())
        assert run.result is not None
        original = run.result.observations[0]
        oversized = BoundedObservation(
            result_count=original.result_count,
            content_sha256_prefix=original.content_sha256_prefix,
            body_truncated_to_cap="x" * (run.result.token.max_bytes + 1),
            body_was_truncated=original.body_was_truncated,
        )
        with self.assertRaisesRegex(AuthorityError, "readlane_result_invalid"):
            auth.authorize_result(
                run.result.token,
                run.result.receipts,
                (oversized, run.result.observations[1]),
            )

    def test_outer_chain_registry_rejects_unknown_fields(self):
        auth, _, run = run_with_output(valid_operator_output())
        assert run.result is not None
        chain = computer_chain(run.result)
        chain["unexpected"] = True
        with self.assertRaisesRegex(AuthorityError, "readlane_chain_mismatch"):
            auth.authorize_computer_chain(run.result, chain)

    def test_outer_chain_registry_rejects_invalid_projection(self):
        auth, _, run = run_with_output(valid_operator_output())
        assert run.result is not None
        chain = computer_chain(run.result)
        chain["projection"]["candidate_count"] = 2
        with self.assertRaisesRegex(AuthorityError, "readlane_chain_mismatch"):
            auth.authorize_computer_chain(run.result, chain)

    def test_public_result_verifier_returns_false_for_non_mapping_receipts(self):
        auth, _, run = run_with_output(valid_operator_output())
        assert run.result is not None
        malformed = type(run.result)(
            token=run.result.token,
            receipts=(None, None, None, None),
            observations=run.result.observations,
            authorization_tag=run.result.authorization_tag,
        )
        self.assertFalse(auth.verify_result(malformed))

    def test_public_chain_verifier_returns_false_for_non_json_values(self):
        auth = authority()
        self.assertFalse(auth.verify_computer_chain({"value": object()}, "0" * 64))


class CapBoundaryTests(unittest.TestCase):
    def test_task_source_cap_fails_before_operator(self):
        auth = authority()
        operator = SingleTurnStubOperator(valid_operator_output())
        run = ReadLane(auth).run(
            task(source="x" * (MAX_SCOPE_BYTES + 1)),
            scope(auth),
            operator,
            adapter(),
        )
        self.assertFalse(run.ok)
        self.assertEqual(run.receipts[0]["reason_code"], "source_cap_exceeded")
        self.assertEqual(operator.calls, 0)

    def test_adapter_global_cap_fails_closed(self):
        class OversizedAdapter(FakeObservationAdapter):
            def search(self, path, query, max_results):
                del path, query, max_results
                return ["x" * (MAX_SCOPE_BYTES + 1)]

        auth = authority()
        run = ReadLane(auth).run(
            task(),
            scope(auth),
            SingleTurnStubOperator(valid_operator_output()),
            OversizedAdapter({"src/readlane.py": "bounded"}),
        )
        self.assertFalse(run.ok)
        self.assertEqual(run.receipts[0]["reason_code"], "adapter_cap_exceeded")


class IndependentVerificationTests(unittest.TestCase):
    def test_source_contract_is_independently_green(self):
        receipt = verify_source_contract()
        self.assertTrue(receipt["ok"], receipt)
        self.assertEqual(receipt["contract_sha256_prefix"], CONTRACT_SHA256_PREFIX)
        self.assertEqual(receipt["violation_count"], 0)
        self.assertFalse(receipt["live_state_touched"])

    def test_source_verifier_covers_every_runtime_module(self):
        receipt = verify_source_contract()
        self.assertTrue(receipt["ok"], receipt)
        # Every module of the subpackage except the verifier itself must be on its list,
        # otherwise a newly added module would silently escape the check.
        on_disk = {path.name for path in Path(static_check.__file__).parent.glob("*.py")}
        self.assertEqual(on_disk - {"static_check.py"}, set(RUNTIME_MODULES))
        self.assertEqual(receipt["files_scanned"], len(RUNTIME_MODULES) + 1)

    def test_contract_hash_is_canonical(self):
        self.assertEqual(
            hashlib.sha256(canonical_bytes(CONTRACT)).hexdigest()[:12],
            CONTRACT_SHA256_PREFIX,
        )
