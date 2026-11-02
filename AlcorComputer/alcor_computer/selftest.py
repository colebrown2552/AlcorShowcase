"""Offline self-test: four refusals, one acceptance and two static checks, as one JSON receipt.

``python -m alcor_computer.selftest`` needs nothing but the standard library. It builds a valid
read-chain and click bundle, then mutates them four ways (forged chain, stale scope, ambiguous
projection, replay) and expects the exact refusal for each; one unmutated pair must be accepted
without firing input. It also scans the package's top-level modules for any import that could
move a pointer or open a connection, and re-runs the authority's static verifier. Exit status 0
means every check passed.

The fixtures here use a stub verifier (``VALID_ISSUER`` / ``VALID_OBSERVATION`` hashes) so the
mediator can be exercised without running the authority lane; ``mediator.py``'s integration with
the real lane is covered by the tests and the demo.
"""

from __future__ import annotations

import ast
import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from .authority.static_check import verify_source_contract
from .contracts import SCHEMA_NAME, STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX, sha256_hex
from .mediator import ComputerUseMediator, ReplayLedger
from .readlane_adapter import READ_SCOPE_CONTRACT_SHA256_PREFIX

NOW_MS = 1_800_000_000_000
READ_SCOPE_PREFIX = READ_SCOPE_CONTRACT_SHA256_PREFIX
VALID_ISSUER = "1" * 64
VALID_OBSERVATION = "2" * 64
_BANNED_IMPORT_ROOTS = frozenset(
    {
        "ctypes",
        "keyboard",
        "mouse",
        "pyautogui",
        "pynput",
        "requests",
        "socket",
        "subprocess",
        "urllib",
    }
)


def fixture() -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a valid ``(read_chain, computer_bundle)`` pair for ``mediator()``."""
    chain: dict[str, Any] = {
        "schema": SCHEMA_NAME,
        "arm": "read-chain",
        "scope_id": "scope-001",
        "scope_contract_sha256_prefix": READ_SCOPE_PREFIX,
        "issuer_receipt_sha256": VALID_ISSUER,
        "observation_receipt_sha256": VALID_OBSERVATION,
        "issued_at_unix_ms": NOW_MS - 1_000,
        "expires_at_unix_ms": NOW_MS + 10_000,
        "nonce": "read-nonce-00000001",
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
    bundle: dict[str, Any] = {
        "schema": SCHEMA_NAME,
        "arm": "computer bundle",
        "scope_id": chain["scope_id"],
        "mediator_contract_sha256_prefix": STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
        "read_chain_sha256": sha256_hex(chain),
        "nonce": "bundle-nonce-000001",
        "action": {
            "operation": "click",
            "target_ref": chain["projection"]["target_ref"],
            "button": "left",
        },
    }
    return chain, bundle


def mediator() -> ComputerUseMediator:
    """Return a mediator with an in-memory ledger, a fixed clock and a stub verifier."""

    def verifier(chain: dict[str, Any], _: str) -> bool:
        return (
            chain["issuer_receipt_sha256"] == VALID_ISSUER
            and chain["observation_receipt_sha256"] == VALID_OBSERVATION
        )

    return ComputerUseMediator(
        read_scope_contract_sha256_prefix=READ_SCOPE_PREFIX,
        read_chain_verifier=verifier,
        replay_ledger=ReplayLedger(),
        now_ms=lambda: NOW_MS,
    )


def _static_no_input_receipt() -> dict[str, Any]:
    """Parse the package's top-level modules and flag imports that could drive input or a socket."""
    root = Path(__file__).resolve().parent
    violations: list[str] = []
    paths = sorted(root.glob("*.py"))
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=path.name)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = {alias.name.split(".", 1)[0] for alias in node.names}
                if roots & _BANNED_IMPORT_ROOTS:
                    violations.append(path.name)
            elif isinstance(node, ast.ImportFrom) and node.module:
                if node.module.split(".", 1)[0] in _BANNED_IMPORT_ROOTS:
                    violations.append(path.name)
    return {
        "test_name": "no_owner_gated_input_static_check",
        "ok": not violations,
        "owner_gated_input_reachable": bool(violations),
        "files_scanned": len(paths),
        "violation_count": len(set(violations)),
    }


def run() -> dict[str, Any]:
    """Run the red/green suite and the static checks and return the combined receipt."""
    med = mediator()
    chain, bundle = fixture()

    forged_chain = deepcopy(chain)
    forged_chain["issuer_receipt_sha256"] = "9" * 64
    forged_bundle = deepcopy(bundle)
    forged_bundle["read_chain_sha256"] = sha256_hex(forged_chain)

    stale_chain = deepcopy(chain)
    stale_chain["expires_at_unix_ms"] = NOW_MS
    stale_bundle = deepcopy(bundle)
    stale_bundle["read_chain_sha256"] = sha256_hex(stale_chain)

    ambiguous_chain = deepcopy(chain)
    ambiguous_chain["projection"]["candidate_count"] = 2
    ambiguous_bundle = deepcopy(bundle)
    ambiguous_bundle["read_chain_sha256"] = sha256_hex(ambiguous_chain)

    cases = [
        ("forged_observe_click", forged_chain, forged_bundle, "forged_observe_click"),
        ("stale_scope", stale_chain, stale_bundle, "stale_scope"),
        ("projection_failure", ambiguous_chain, ambiguous_bundle, "projection_failure"),
    ]
    reds: list[dict[str, Any]] = []
    for name, red_chain, red_bundle, expected in cases:
        receipt = med.stage_json_pair(
            json.dumps(red_chain, separators=(",", ":")),
            json.dumps(red_bundle, separators=(",", ":")),
        )
        reds.append(
            {
                "test_name": name,
                "rejected": receipt["rejected"],
                "reason_code": receipt["reason_code"],
                "expected_reason": expected,
                "ok": receipt["rejected"] and receipt["reason_code"] == expected,
            }
        )

    first = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
    replay = med.stage_json_pair(json.dumps(chain), json.dumps(bundle))
    reds.append(
        {
            "test_name": "replay",
            "rejected": replay["rejected"],
            "reason_code": replay["reason_code"],
            "expected_reason": "replay",
            "ok": first["accepted"] and replay["rejected"] and replay["reason_code"] == "replay",
        }
    )

    static_receipt = _static_no_input_receipt()
    source = verify_source_contract()
    red_ok = sum(1 for item in reds if item["ok"])
    green_ok = int(first["accepted"] and first["input_fired"] is False)
    return {
        "schema": "alcor.computer.selftest.v1",
        "owner_gated": False,
        "red_suite": {
            "passed": red_ok,
            "total": 4,
            "ok": red_ok == 4,
            "tests": reds,
        },
        "green_suite": {
            "passed": green_ok,
            "total": 1,
            "ok": green_ok == 1,
            "test_names": ["valid_read_chain_to_computer_bundle"],
        },
        "strict_mediator_contract_sha256_prefix": STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
        "read_scope_contract_sha256_prefix": READ_SCOPE_PREFIX,
        "read_scope_contract_frozen_green": source["ok"] is True,
        "read_scope_source_verification": source,
        "no_owner_gated_input": static_receipt,
        "ok": red_ok == 4 and green_ok == 1 and static_receipt["ok"] and source["ok"] is True,
    }


def main() -> int:
    """Print the receipt as indented JSON and return 0 only if every check passed."""
    receipt = run()
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if receipt["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
