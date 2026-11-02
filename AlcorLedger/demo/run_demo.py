"""End-to-end demo of continuity-core: hash chain, privacy gate, tamper detection, reconstruction.

Run it from anywhere with ``python AlcorLedger/demo/run_demo.py``. It needs no install, no network and
no configuration. Ids and timestamps are fixed, so the printed hashes are identical on every run.
Each claim is asserted: the script exits non-zero if the behaviour regresses.

The library is used where the demo needs to catch exceptions and inspect findings. Verification,
scanning and the other verbs go through the real ``continuity`` command line, as a user would.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

# Lets the demo run from a fresh checkout without `pip install`.
SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from continuity_core import ChainError, JsonlLedger, SensitiveDataError  # noqa: E402
from continuity_core.ledger import ZERO_HASH  # noqa: E402
from continuity_core.reconstruct import (  # noqa: E402
    PROOF_SCHEMA,
    PROOF_TAG,
    ReconstructionError,
    verify_pass_k,
)

checks_passed = 0


def heading(title: str) -> None:
    print(f"\n== {title} ==")


def expect(condition: bool, claim: str) -> None:
    """Print a proven claim, or stop the demo if it does not hold."""
    global checks_passed
    if not condition:
        sys.exit(f"DEMO FAILED: {claim}")
    checks_passed += 1
    print(f"   proven: {claim}")


def capture(action: Callable[[], object], *exception_types: type[BaseException]):
    """Run ``action`` and return the exception it raised, or None if it completed normally."""
    try:
        action()
    except exception_types as error:
        return error
    return None


def short(digest: str) -> str:
    return digest[:12]


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_lines(path: Path, lines: list[str]) -> None:
    """Replace the file with ``lines``, using LF endings on every platform."""
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def run_cli(workdir: Path, *args: str) -> tuple[int, str, str]:
    """Run ``continuity <args>`` in a fresh interpreter and return (exit code, stdout, stderr).

    The working directory is the demo's temporary folder and ledger paths are relative, so no
    absolute path ever appears in the output.
    """
    process = subprocess.run(
        [sys.executable, "-B", "-m", "continuity_core", *args],
        cwd=workdir,
        env={**os.environ, "PYTHONPATH": str(SRC), "PYTHONUTF8": "1"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    return process.returncode, process.stdout, process.stderr


def forge_hash(entry: dict) -> str:
    """Recompute an entry hash the way the ledger does: SHA-256 of sorted-key compact JSON."""
    body = {key: value for key, value in entry.items() if key != "entry_hash"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_text(canonical)


def part_chain_and_privacy(workdir: Path) -> None:
    ledger_path = workdir / "ledger.jsonl"
    ledger = JsonlLedger(ledger_path)

    heading("1. Append entries: each one commits to the one before it")
    entries = [
        {
            "id": "decision-1",
            "kind": "decision",
            "statement": "Receipts outrank narrative confidence.",
            "tags": ["policy"],
            "created_at": "2026-01-01T09:00:00Z",
        },
        {
            "id": "obs-1",
            "kind": "observation",
            "statement": "The nightly export finished in 41 seconds.",
            "confidence": 0.9,
            "provenance": "runtime",
            "created_at": "2026-01-01T09:05:00Z",
        },
        {
            "id": "wish-1",
            "kind": "wishlist",
            "statement": "Add a replay tool for state transitions.",
            "created_at": "2026-01-01T09:10:00Z",
        },
    ]
    stored = [ledger.append(entry) for entry in entries]
    for number, entry in enumerate(stored, start=1):
        print(
            f"   line {number}: {entry['kind']:<11} {entry['id']:<11} "
            f"previous={short(entry['previous_hash'])} hash={short(entry['entry_hash'])}"
        )
    expect(stored[0]["previous_hash"] == ZERO_HASH, "the first entry points at the all-zero hash")
    expect(
        stored[1]["previous_hash"] == stored[0]["entry_hash"]
        and stored[2]["previous_hash"] == stored[1]["entry_hash"],
        "every other entry stores the hash of the entry before it",
    )

    heading("2. Privacy gate: a secret is refused by default")
    risky = {
        "id": "obs-2",
        "kind": "observation",
        "statement": "Page the on-call engineer at alice@example.com if the export fails.",
        "created_at": "2026-01-01T09:15:00Z",
    }
    size_before = ledger_path.stat().st_size
    refusal = capture(lambda: ledger.append(risky), SensitiveDataError)
    expect(refusal is not None, "an entry containing an email address is refused")
    print(f"   refused: {refusal}")
    for finding in refusal.findings:
        print(
            f"   finding: label={finding.label} location={finding.location} "
            f"length={finding.length} fingerprint={finding.fingerprint}"
        )
    expect(ledger_path.stat().st_size == size_before, "nothing was written to the ledger")
    expect(
        "alice" not in str(refusal)
        and all("alice" not in json.dumps(f.as_dict()) for f in refusal.findings),
        "the error and the findings describe the value but never contain it",
    )

    heading("3. Privacy gate: redaction is explicit, and the original never reaches disk")
    redacted = ledger.append(risky, redact=True)
    print(f"   stored statement: {redacted['statement']}")
    keyed = ledger.append(
        {
            "id": "obs-3",
            "kind": "observation",
            "statement": "Service credentials were rotated after the review.",
            "metadata": {"api_key": "not-a-real-key", "region": "eu-west"},
            "created_at": "2026-01-01T09:20:00Z",
        },
        redact=True,
    )
    print(f"   stored metadata : {json.dumps(keyed['metadata'], sort_keys=True)}")
    raw = ledger_path.read_text(encoding="utf-8")
    expect(
        "alice@example.com" not in raw and "not-a-real-key" not in raw,
        "neither original value appears anywhere in the file",
    )
    expect(
        keyed["metadata"]["region"] == "eu-west",
        "only the sensitive key was replaced; harmless metadata is kept",
    )

    heading("4. Verify the chain with the CLI")
    code, out, _ = run_cli(workdir, "verify", "ledger.jsonl")
    report = json.loads(out)
    print(f"   continuity verify ledger.jsonl -> exit {code}, entries={report['entries']}")
    expect(code == 0 and report["ok"] and report["entries"] == 5, "an untouched ledger verifies")

    heading("5. Tamper with one line on disk")
    original_lines = raw.splitlines()
    edited = original_lines[1].replace("41 seconds", "4 seconds")
    expect(edited != original_lines[1], "line 2 now says 4 seconds instead of 41 seconds")
    write_lines(ledger_path, [original_lines[0], edited, *original_lines[2:]])
    code, out, _ = run_cli(workdir, "verify", "ledger.jsonl")
    report = json.loads(out)
    print(f"   continuity verify ledger.jsonl -> exit {code}")
    for error in report["errors"]:
        print(f"   error: {error}")
    expect(
        code == 1 and report["errors"] == ["line 2: entry_hash mismatch"],
        "verify exits 1 and names the line and the reason",
    )
    late_entry = {"id": "obs-4", "kind": "observation", "statement": "A late note."}
    chain_error = capture(lambda: ledger.append(late_entry), ChainError)
    expect(chain_error is not None, "append refuses to extend a ledger that fails verification")
    print(f"   ChainError: {chain_error}")

    heading("6. A forger who recomputes that line's own hash is caught one line later")
    forged = json.loads(edited)
    forged["entry_hash"] = forge_hash(forged)
    write_lines(ledger_path, [original_lines[0], json.dumps(forged), *original_lines[2:]])
    code, out, _ = run_cli(workdir, "verify", "ledger.jsonl")
    report = json.loads(out)
    for error in report["errors"]:
        print(f"   error: {error}")
    expect(
        code == 1 and report["errors"] == ["line 3: previous_hash mismatch"],
        "line 2 is now self-consistent, but line 3 still points at the old hash",
    )

    heading("7. What the chain alone cannot see")
    pinned_head = json.loads(original_lines[-1])["entry_hash"]
    write_lines(ledger_path, original_lines[:-1])
    code, out, _ = run_cli(workdir, "verify", "ledger.jsonl")
    report = json.loads(out)
    print(f"   newest entry deleted -> verify exit {code}, entries={report['entries']}")
    expect(code == 0, "a ledger shortened from the end still verifies")
    current_head = json.loads(ledger_path.read_text(encoding="utf-8").splitlines()[-1])
    expect(
        current_head["entry_hash"] != pinned_head,
        "comparing against a head hash kept elsewhere does detect it (pin the head)",
    )


def part_cli_verbs(workdir: Path) -> None:
    heading("8. The other verbs through the CLI: init, append, list, scan")
    code, out, _ = run_cli(workdir, "init", "state")
    created = json.loads(out)["created"]
    print(f"   continuity init state -> exit {code}, created {len(created)} paths")
    expect(code == 0 and len(created) == 5, "init lays out four ledgers and a local-state marker")

    ledger = "state/memory/public.jsonl"
    code, out, _ = run_cli(
        workdir,
        "append",
        ledger,
        "--kind",
        "decision",
        "--id",
        "cli-1",
        "--statement",
        "Tests and receipts outrank narrative confidence.",
    )
    print(f"   continuity append (clean statement)  -> exit {code}")
    expect(code == 0 and json.loads(out)["id"] == "cli-1", "a clean entry is appended")

    code, out, err = run_cli(
        workdir,
        "append",
        ledger,
        "--kind",
        "memory",
        "--statement",
        "Send the report to bob@example.com",
    )
    print(f"   continuity append (contains email)   -> exit {code}, {json.loads(err)['type']}")
    expect(code == 2 and "bob@example.com" not in err, "a secret is refused with exit code 2")

    code, out, _ = run_cli(workdir, "list", ledger, "--limit", "1")
    listed = json.loads(out.splitlines()[0])
    print(f"   continuity list --limit 1             -> {listed['id']}: {listed['statement']}")
    expect(code == 0 and len(out.splitlines()) == 1, "list streams entries and honours --limit")

    notes = workdir / "notes.txt"
    notes.write_text("deploy notes\ncontact: carol@example.com\n", encoding="utf-8")
    code, out, _ = run_cli(workdir, "scan", "notes.txt")
    finding = json.loads(out.splitlines()[0])["finding"]
    print(
        f"   continuity scan notes.txt             -> exit {code}, label={finding['label']}, "
        f"length={finding['length']}, fingerprint={finding['fingerprint']}"
    )
    expect(code == 1 and "carol" not in out, "scan exits 1 and reports the category, not the value")


def build_proof(path: Path, cache_used_on_turn_two: bool = False) -> None:
    """Write three proof turns, as a restarted agent would have recorded them."""
    ledger = JsonlLedger(path)
    for turn in (1, 2, 3):
        ledger.append(
            {
                "id": f"proof-{turn}",
                "kind": "observation",
                "status": "confirmed",
                "statement": f"Turn {turn} accepted.",
                "provenance": "test",
                "tags": [PROOF_TAG],
                "created_at": f"2026-01-01T10:0{turn}:00Z",
                "metadata": {
                    "proof_schema": PROOF_SCHEMA,
                    "turn_index": turn,
                    "thread_id_hash": sha256_text("thread-a"),
                    "accepted_result_hash": sha256_text(f"result-{turn}"),
                    "terminal_result_count": 1,
                    "completion_receipt": True,
                    "cache_used": cache_used_on_turn_two and turn == 2,
                    "quarantined_request_retried": False,
                    # Turn 3 runs in a different process than turns 1 and 2.
                    "process_marker_hash": sha256_text("process-b" if turn == 3 else "process-a"),
                },
            }
        )


def part_reconstruction(workdir: Path) -> None:
    heading("9. Rebuild a recorded three-turn exchange from the chain alone")
    good = workdir / "proof.jsonl"
    build_proof(good)
    receipt = verify_pass_k(good, k=3)
    print(
        f"   state_digest={short(receipt['state_digest'])} passes={receipt['pass_count']} "
        f"cache_used={receipt['cache_used']}"
    )
    expect(
        receipt["ok"] and receipt["turn_three_process_distinct"],
        "three identical cold reconstructions agree, and turn 3 ran in a distinct process",
    )

    cached = workdir / "proof-cached.jsonl"
    build_proof(cached, cache_used_on_turn_two=True)
    cache_failure = capture(lambda: verify_pass_k(cached), ReconstructionError)
    print(f"   turn 2 recorded cache_used=True -> {cache_failure}")
    expect(str(cache_failure) == "cache-use-not-proven-false", "a recorded cache use fails closed")

    lines = good.read_text(encoding="utf-8").splitlines()
    lines[1] = lines[1].replace("Turn 2 accepted.", "Turn 2 rewritten.")
    write_lines(good, lines)
    chain_failure = capture(lambda: verify_pass_k(good), ReconstructionError)
    print(f"   one line edited on disk         -> {chain_failure}")
    expect(
        str(chain_failure) == "ledger-chain-invalid",
        "reconstruction refuses a ledger that fails verify",
    )


def main() -> int:
    print("continuity-core demo: hash-chained ledger with a privacy gate")
    with tempfile.TemporaryDirectory() as directory:
        workdir = Path(directory)
        part_chain_and_privacy(workdir)
        part_cli_verbs(workdir)
        part_reconstruction(workdir)
    print(f"\nAll {checks_passed} claims proven.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
