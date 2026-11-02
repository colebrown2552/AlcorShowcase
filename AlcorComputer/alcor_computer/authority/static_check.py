"""Independent static verifier for the read-lane authority.

This module re-reads the checked-in contract and parses every module of the authority subpackage
with ``ast``. It does not import them. The aim is to make the "source-only" claim checkable: the
contract must state the expected invariants, and no authority module may import a network,
process or input library, call a file-writing function, read ``os.environ`` or contain a URL
literal.

It is a tripwire, not a sandbox. It catches the obvious ways of adding a live path; it cannot
stop code that imports something unusual under another name.

Run it with ``python -m alcor_computer.authority.static_check``; exit status 0 means green.
"""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Any

SCHEMA = "alcor.authority.readlane.verification.v1"
FORBIDDEN_IMPORT_ROOTS = frozenset(
    (
        "aiohttp",
        "ctypes",
        "http",
        "pynput",
        "pyautogui",
        "requests",
        "socket",
        "subprocess",
        "urllib",
    )
)
FORBIDDEN_CALL_NAMES = frozenset(
    (
        "chmod",
        "mkdir",
        "open",
        "popen",
        "remove",
        "rename",
        "replace",
        "rmdir",
        "system",
        "touch",
        "unlink",
        "write_bytes",
        "write_text",
    )
)
# Modules the verifier covers. A new module must be added here or it is not checked.
RUNTIME_MODULES = (
    "__init__.py",
    "contract.py",
    "values.py",
    "issuer.py",
    "result_checks.py",
    "operator_checks.py",
    "observation.py",
    "lane.py",
)
_EXPECTED_OPERATOR_INVARIANTS = {
    "single_turn": True,
    "data_only": True,
    "may_grant_authority": False,
    "may_widen_scope": False,
    "may_complete_step": False,
    "may_mutate_canonical_state": False,
}
_EXPECTED_SCOPE_AUTHENTICATION = {
    "contract_bound": True,
    "deterministic": True,
    "process_local_completed_chain_registry": True,
    "serialized_secret_present": False,
    "tag_semantics": "integrity_check_not_authentication",
}


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _contract_violations(contract: dict[str, Any]) -> list[str]:
    """Compare the contract file with the invariants this subpackage promises."""
    checks = (
        ("contract_schema", contract.get("schema"), "alcor.authority.readlane.contract.v1"),
        ("receipt_schema", contract.get("receipt_schema"), "alcor.authority.readlane.v1"),
        (
            "base_receipt_schema",
            contract.get("extends_receipt_schema"),
            "alcor.authority.receipt.v1",
        ),
        ("verb_allowlist", contract.get("allowed_verbs"), ["read", "search"]),
        (
            "phase_order",
            contract.get("read_chain_phases"),
            ["prepared", "search", "read", "completed"],
        ),
        ("operator_invariants", contract.get("operator_invariants"), _EXPECTED_OPERATOR_INVARIANTS),
        (
            "scope_authentication",
            contract.get("scope_authentication"),
            _EXPECTED_SCOPE_AUTHENTICATION,
        ),
    )
    return [name for name, actual, expected in checks if actual != expected]


def _module_violations(source: str, filename: str) -> list[str]:
    """Return the rule names broken by one module's source text."""
    violations: list[str] = []
    # An endpoint written into the source would be a hard-coded way out of the package.
    if "://" in source:
        violations.append("url_literal")
    for node in ast.walk(ast.parse(source, filename=filename)):
        if isinstance(node, ast.Import):
            if any(alias.name.split(".", 1)[0] in FORBIDDEN_IMPORT_ROOTS for alias in node.names):
                violations.append("network_or_input_import")
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.module.split(".", 1)[0] in FORBIDDEN_IMPORT_ROOTS:
                violations.append("network_or_input_import")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                call_name = node.func.id
            elif isinstance(node.func, ast.Attribute):
                call_name = node.func.attr
            else:
                call_name = ""
            if call_name in FORBIDDEN_CALL_NAMES:
                violations.append("write_or_process_call")
        elif (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "os"
            and node.attr == "environ"
        ):
            violations.append("environment_authority")
    return violations


def verify_source_contract() -> dict[str, Any]:
    """Verify the contract file and the authority modules, and return a sanitised receipt.

    Returns:
        A dict with ``ok``, a ``reason_code`` (``source_contract_green``, ``source_contract_red``
        or ``verification_error``), the contract hash prefix, how many files were scanned and how
        many distinct rules were violated. It names no file and no violated rule.
    """
    root = Path(__file__).resolve().parent
    contract_path = root.parent / "contracts" / "alcor_authority_readlane_v1.json"
    violations: list[str] = []
    try:
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        prefix = hashlib.sha256(_canonical_bytes(contract)).hexdigest()[:12]
        violations.extend(_contract_violations(contract))
        for name in RUNTIME_MODULES:
            source = (root / name).read_text(encoding="utf-8")
            violations.extend(_module_violations(source, name))
    except Exception:
        return {
            "schema": SCHEMA,
            "ok": False,
            "reason_code": "verification_error",
            "contract_sha256_prefix": "0" * 12,
            "files_scanned": 0,
            "violation_count": 1,
            "live_state_touched": False,
        }
    unique = sorted(set(violations))
    return {
        "schema": SCHEMA,
        "ok": not unique,
        "reason_code": "source_contract_green" if not unique else "source_contract_red",
        "contract_sha256_prefix": prefix,
        "files_scanned": len(RUNTIME_MODULES) + 1,
        "violation_count": len(unique),
        "live_state_touched": False,
    }


if __name__ == "__main__":
    receipt = verify_source_contract()
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    raise SystemExit(0 if receipt["ok"] else 1)
