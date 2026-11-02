"""The mediator wired to the real read-lane authority: a completed chain stages once."""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from copy import deepcopy
from pathlib import Path

from alcor_computer.authority import (
    OPERATOR_OUTPUT_SCHEMA,
    TASK_INPUT_SCHEMA,
    FakeObservationAdapter,
    ReadLane,
    SingleTurnStubOperator,
    default_authority,
)
from alcor_computer.contracts import (
    SCHEMA_NAME,
    STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
    sha256_hex,
)
from alcor_computer.readlane_adapter import READ_SCOPE_CONTRACT_SHA256_PREFIX
from alcor_computer.secure_mediator import ComputerUseMediator


def write_binding(root: Path) -> None:
    contracts = root / "alcor_computer" / "contracts"
    contracts.mkdir(parents=True, exist_ok=True)
    (contracts / "alcor_read_scope_binding_v1.json").write_text(
        json.dumps(
            {
                "schema": "alcor.computer.read-scope-binding.v1",
                "contract_sha256_prefix": READ_SCOPE_CONTRACT_SHA256_PREFIX,
                "frozen": True,
                "independently_green": True,
            }
        ),
        encoding="utf-8",
    )


def completed_source_result():
    authority = default_authority()
    token = authority.issue_scope(
        ["src/*"],
        ["read", "search"],
        max_results=3,
        max_bytes=64,
    )
    task = {
        "schema": TASK_INPUT_SCHEMA,
        "task": "read-chain",
        "tool_access": True,
        "source": "bounded source",
    }
    operator = SingleTurnStubOperator(
        {
            "schema": OPERATOR_OUTPUT_SCHEMA,
            "actions": [
                {
                    "verb": "search",
                    "path": "src/readlane.py",
                    "query": "typed",
                    "max_results": 2,
                    "max_bytes": 48,
                },
                {
                    "verb": "read",
                    "path": "src/readlane.py",
                    "query": None,
                    "max_results": 1,
                    "max_bytes": 48,
                },
            ],
            "requested_scope": None,
            "authority_granted": False,
            "step_completed": False,
            "canonical_state_mutated": False,
        }
    )
    adapter = FakeObservationAdapter(
        {
            "src/readlane.py": "typed code validates observations " * 8,
            "src/other.py": "typed auxiliary document",
        }
    )
    run = ReadLane(authority).run(task, token, operator, adapter)
    if not run.ok or run.result is None:
        raise AssertionError(run.receipts)
    return authority, run.result


def source_authorized_pair():
    authority, result = completed_source_result()
    now_ms = time.time_ns() // 1_000_000
    chain = {
        "schema": SCHEMA_NAME,
        "arm": "read-chain",
        "scope_id": result.token.scope_id,
        "scope_contract_sha256_prefix": READ_SCOPE_CONTRACT_SHA256_PREFIX,
        "issuer_receipt_sha256": sha256_hex(result.receipts[0]),
        "observation_receipt_sha256": sha256_hex(list(result.receipts)),
        "issued_at_unix_ms": now_ms - 1_000,
        "expires_at_unix_ms": now_ms + 10_000,
        "nonce": f"readlane-{time.time_ns()}",
        "frame_sha256": "3" * 64,
        "projection": {
            "target_ref": "button.primary",
            "candidate_count": 1,
            "x": 400,
            "y": 300,
            "screen_width": 1440,
            "screen_height": 900,
        },
    }
    digest = authority.authorize_computer_chain(result, chain)
    bundle = {
        "schema": SCHEMA_NAME,
        "arm": "computer bundle",
        "scope_id": chain["scope_id"],
        "mediator_contract_sha256_prefix": STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
        "read_chain_sha256": digest,
        "nonce": f"bundle-{time.time_ns()}",
        "action": {
            "operation": "click",
            "target_ref": chain["projection"]["target_ref"],
            "button": "left",
        },
    }
    return chain, bundle


class SourceWiredIntegrationTests(unittest.TestCase):
    def test_completed_source_chain_stages_once_without_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_binding(root)
            chain, bundle = source_authorized_pair()
            mediator = ComputerUseMediator.for_repo(root)
            status = mediator.status()
            self.assertTrue(status["validation_ready"])
            self.assertTrue(status["read_scope_verifier_available"])

            first = mediator.stage_json_pair(json.dumps(chain), json.dumps(bundle))
            self.assertTrue(first["accepted"])
            self.assertTrue(first["staged"])
            self.assertTrue(first["replay_recorded"])
            self.assertFalse(first["input_fired"])
            self.assertFalse(first["desktop_state_touched"])

            replay = deepcopy(bundle)
            replay["nonce"] = f"bundle-replay-{time.time_ns()}"
            second = mediator.stage_json_pair(json.dumps(chain), json.dumps(replay))
            self.assertEqual(second["reason_code"], "replay")
            self.assertFalse(second["input_fired"])

    def test_unregistered_chain_is_forced_red(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_binding(root)
            chain, bundle = source_authorized_pair()
            forged = deepcopy(chain)
            forged["nonce"] = f"unregistered-{time.time_ns()}"
            forged_bundle = deepcopy(bundle)
            forged_bundle["read_chain_sha256"] = sha256_hex(forged)
            receipt = ComputerUseMediator.for_repo(root).stage_json_pair(
                json.dumps(forged),
                json.dumps(forged_bundle),
            )
            self.assertEqual(receipt["reason_code"], "forged_observe_click")
            self.assertFalse(receipt["input_fired"])
            self.assertFalse(receipt["desktop_state_touched"])


if __name__ == "__main__":
    unittest.main()
