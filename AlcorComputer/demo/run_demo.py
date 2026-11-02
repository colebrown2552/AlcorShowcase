"""Computer-use demo: a contract-bound session on a fake desktop, with refusals and receipts.

Run it from anywhere:

    python AlcorComputer/demo/run_demo.py

Nothing real is touched. The "desktop" is a few lines of in-memory Python (``FakeHost``), the
real macOS app backend is driven through its test seams so its prepare-then-perform protocol runs
for real, and a tripwire makes any attempt to reach ``subprocess`` or ``ctypes.CDLL`` raise, so a
pass proves no operating-system input API was used. It is offline and deterministic: only
reason codes, booleans and counts are printed, never random ids.

Two parts:

1. The mediator. The authority lane observes a (fake) screen, a click proposal is bound to that
   observation by hash, and the mediator stages it once. A replay, a forged chain, a stale scope
   and several out-of-contract bundles are refused, each with its reason code.
2. App control. An ``AppController`` session needs an owner-written grant, a fresh one-use
   observation and a second identity check before the fake host sees a click or typed text.

The exit status is 0 only if every expectation holds, so the script doubles as an end-to-end test.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import sys
import tempfile
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

# Make the package importable without installing it: the component root is the demo's parent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alcor_computer import (  # noqa: E402
    AppControlError,
    AppController,
    ComputerUseMediator,
    ReplayLedger,
)
from alcor_computer.app_control import GRANT_SCHEMA  # noqa: E402
from alcor_computer.authority import (  # noqa: E402
    CONTRACT_SHA256_PREFIX,
    OPERATOR_OUTPUT_SCHEMA,
    TASK_INPUT_SCHEMA,
    AuthorityError,
    FakeObservationAdapter,
    ReadLane,
    SingleTurnStubOperator,
    default_authority,
)
from alcor_computer.backends import macos_app  # noqa: E402
from alcor_computer.backends.macos_app import MacOSAppBackend  # noqa: E402
from alcor_computer.contracts import (  # noqa: E402
    SCHEMA_NAME,
    STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
    sha256_hex,
)

COMPONENT_ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc).timestamp()
NOW_MS = int(NOW * 1000)
TARGET = "com.example.DemoApp"
FAILURES: list[str] = []


def section(title: str) -> None:
    print(f"\n== {title} ==")


def expect(label: str, condition: bool, detail: str = "") -> None:
    """Print one check and remember it if it failed."""
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    if not condition:
        FAILURES.append(label)


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


TRIPWIRE_HITS: list[str] = []


@contextlib.contextmanager
def no_os_input() -> Iterator[None]:
    """Make any attempt to start a process or load a native library raise, and count it."""

    def refuse(*_args: Any, **_kwargs: Any) -> None:
        TRIPWIRE_HITS.append("os call attempted")
        raise AssertionError("the demo tried to reach the real operating system")

    with (
        patch.object(macos_app.subprocess, "run", refuse),
        patch.object(macos_app.ctypes, "CDLL", refuse),
    ):
        yield


@contextlib.contextmanager
def private_workdir() -> Iterator[Path]:
    """A scratch directory the controller accepts as private to the current user.

    Python 3.12.4+ gives Windows temp directories an owner-only ACL. On an older Windows Python
    the profile directory is used instead, because it inherits an owner-only ACL.
    """
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        usable = os.name != "nt"
        if not usable:
            from alcor_computer.backends.windows_private import is_private

            usable = is_private(Path(directory))
        if usable:
            yield Path(directory)
            return
    base = Path.home() / ".alcor"
    base.mkdir(parents=True, exist_ok=True)
    fallback = Path(tempfile.mkdtemp(prefix="demo-", dir=base))
    try:
        yield fallback
    finally:
        shutil.rmtree(fallback, ignore_errors=True)


class FakeHost:
    """An in-memory window that records what would have reached the screen."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.typed = ""

    def snapshot(self) -> dict[str, Any]:
        return {
            "ok": True,
            "bundle_id": TARGET,
            "pid": 4242,
            "process": "DemoApp",
            "window_title": "Demo window",
            "window_bounds": {"x": 0, "y": 0, "width": 800, "height": 600},
            "frontmost": True,
        }

    def apply(self, action: dict[str, Any], _target: dict[str, Any]) -> None:
        self.events.append(dict(action))
        if action["kind"] == "type":
            self.typed += action["text"]


def reasons(receipt: dict[str, Any]) -> str:
    return str(receipt["reason_code"])


def mediator_part(workdir: Path) -> None:
    section("1. Mediator: a click proposal bound to an observation the authority produced")
    authority = default_authority()
    token = authority.issue_scope(["screen/*"], ["read", "search"], max_results=3, max_bytes=64)
    operator = SingleTurnStubOperator(
        {
            "schema": OPERATOR_OUTPUT_SCHEMA,
            "actions": [
                {
                    "verb": "search",
                    "path": "screen/dialog.txt",
                    "query": "save",
                    "max_results": 2,
                    "max_bytes": 48,
                },
                {
                    "verb": "read",
                    "path": "screen/dialog.txt",
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
    task = {
        "schema": TASK_INPUT_SCHEMA,
        "task": "read-chain",
        "tool_access": True,
        "source": "demo",
    }
    adapter = FakeObservationAdapter(
        {"screen/dialog.txt": "Save button, lower right of the dialog"}
    )
    run = ReadLane(authority).run(task, token, operator, adapter)
    expect("the lane completed prepared -> search -> read -> completed", run.ok)
    assert run.result is not None

    chain = {
        "schema": SCHEMA_NAME,
        "arm": "read-chain",
        "scope_id": run.result.token.scope_id,
        "scope_contract_sha256_prefix": CONTRACT_SHA256_PREFIX,
        "issuer_receipt_sha256": sha256_hex(run.result.receipts[0]),
        "observation_receipt_sha256": sha256_hex(list(run.result.receipts)),
        "issued_at_unix_ms": NOW_MS - 1_000,
        "expires_at_unix_ms": NOW_MS + 10_000,
        "nonce": "demo-read-nonce-0001",
        "frame_sha256": "3" * 64,
        "projection": {
            "target_ref": "button.save",
            "candidate_count": 1,
            "x": 640,
            "y": 420,
            "screen_width": 800,
            "screen_height": 600,
        },
    }
    digest = authority.authorize_computer_chain(run.result, chain)

    def bundle_for(read_chain_sha256: str, nonce: str = "demo-bundle-nonce-01") -> dict[str, Any]:
        return {
            "schema": SCHEMA_NAME,
            "arm": "computer bundle",
            "scope_id": chain["scope_id"],
            "mediator_contract_sha256_prefix": STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
            "read_chain_sha256": read_chain_sha256,
            "nonce": nonce,
            "action": {"operation": "click", "target_ref": "button.save", "button": "left"},
        }

    ledger_path = workdir / "consumed-bundles.txt"
    mediator = ComputerUseMediator.for_repo(COMPONENT_ROOT, replay_ledger=ReplayLedger(ledger_path))
    mediator.now_ms = lambda: NOW_MS  # a fixed clock keeps the run reproducible
    status = mediator.status()
    print(f"  readiness : validation_ready={status['validation_ready']}")
    print(
        f"  boundary  : actuation_backend_present={status['actuation_backend_present']}"
        f" network_access_present={status['network_access_present']}"
    )
    expect(
        "the mediator is ready only because the pin matches the live authority contract",
        status["validation_ready"] is True,
    )

    def stage(read_chain: dict[str, Any], bundle: dict[str, Any]) -> dict[str, Any]:
        return mediator.stage_json_pair(json.dumps(read_chain), json.dumps(bundle))

    accepted = mediator.validate_json_pair(json.dumps(chain), json.dumps(bundle_for(digest)))
    expect("validate accepts the bound pair without consuming it", accepted["accepted"] is True)
    first = stage(chain, bundle_for(digest))
    print(f"  stage     : reason={reasons(first)} input_fired={first['input_fired']}")
    expect(
        "stage consumes the proposal once and fires no input",
        first["reason_code"] == "staged_no_input"
        and first["input_fired"] is False
        and first["desktop_state_touched"] is False,
    )
    again = stage(chain, bundle_for(digest, nonce="demo-bundle-nonce-02"))
    expect(
        "a replay with a fresh bundle nonce is refused", reasons(again) == "replay", reasons(again)
    )
    lines = ledger_path.read_text(encoding="ascii").splitlines()
    expect(
        "the ledger holds only SHA-256 hashes",
        len(lines) == 1 and all(len(line) == 64 for line in lines),
        f"{len(lines)} hash",
    )

    forged = {**chain, "nonce": "demo-forged-nonce-0001"}
    cases = [
        (
            "chain the authority never registered",
            forged,
            bundle_for(sha256_hex(forged)),
            "forged_observe_click",
        ),
        (
            "scope that already expired",
            {**chain, "issued_at_unix_ms": NOW_MS - 20_000, "expires_at_unix_ms": NOW_MS - 10_000},
            bundle_for(digest),
            "stale_scope",
        ),
        (
            "two candidates on screen",
            {**chain, "projection": {**chain["projection"], "candidate_count": 2}},
            bundle_for(digest),
            "projection_failure",
        ),
        (
            "bundle with an unknown field",
            chain,
            {**bundle_for(digest), "extra": 1},
            "unknown_field",
        ),
        (
            "bundle asking to type, not click",
            chain,
            {
                **bundle_for(digest),
                "action": {"operation": "type", "target_ref": "button.save", "button": "left"},
            },
            "invalid_value",
        ),
        (
            "bundle written for another mediator contract",
            chain,
            {**bundle_for(digest), "mediator_contract_sha256_prefix": "0" * 12},
            "mediator_contract_mismatch",
        ),
    ]
    for label, read_chain, bundle, expected in cases:
        receipt = mediator.validate_json_pair(json.dumps(read_chain), json.dumps(bundle))
        print(f"  {label:<46} -> {reasons(receipt)}")
        expect(f"{label}: {expected}", reasons(receipt) == expected and not receipt["input_fired"])
    ambiguous = {**chain, "projection": {**chain["projection"], "candidate_count": 2}}
    try:
        authority.authorize_computer_chain(run.result, ambiguous)
        refused = ""
    except AuthorityError as exc:
        refused = exc.reason_code
    expect(
        "the authority itself will not register an ambiguous chain",
        refused == "readlane_chain_mismatch",
        refused,
    )


def session_part(workdir: Path) -> None:
    section("2. App control: a grant-bound session on a fake desktop")
    host = FakeHost()
    clock = [100.0]
    backend = MacOSAppBackend(
        TARGET,
        snapshot_provider=host.snapshot,
        effect_provider=host.apply,
        monotonic=lambda: clock[0],
    )
    grant_path = workdir / "grant.json"
    receipt_path = workdir / "receipts.jsonl"
    grant_path.write_text(
        json.dumps(
            {
                "schema": GRANT_SCHEMA,
                "target_bundle_id": TARGET,
                "issued_at": iso(NOW - 1),
                "expires_at": iso(NOW + 120),
                "max_events": 3,
                "allowed_actions": ["focus", "click", "type"],
            }
        ),
        encoding="utf-8",
    )
    grant_path.chmod(0o600)  # required on POSIX; the Windows check reads the directory's ACL
    print(
        "  grant     : owner-written, 120 s, 3 events, actions focus/click/type (no key, no move)"
    )

    try:
        AppController("com.apple.Terminal", backend=backend)
        terminal = ""
    except AppControlError as exc:
        terminal = exc.reason_code
    expect(
        "a terminal emulator can never be the target",
        terminal == "shell_app_target_forbidden",
        terminal,
    )

    controller = AppController(
        TARGET,
        live_opt_in=True,
        ttl_seconds=120,
        max_events=5,
        max_observation_age_ms=2_000,
        grant_path=grant_path,
        receipt_path=receipt_path,
        backend=backend,
        monotonic=lambda: clock[0],
        wall_time=lambda: NOW,
    )
    secret_text = "demo text that must stay out of every receipt"
    try:
        observed = controller.observe()
        clicked = controller.click(640, 420, observed["observation_id"], "Press the Save button.")
        print(f"  click     : reason={reasons(clicked)} events_used={clicked['events_used']}")
        expect(
            "a click with a fresh observation reaches the fake host",
            clicked["ok"] and host.events[-1]["kind"] == "click",
        )
        replayed = controller.click(640, 420, observed["observation_id"], "Press it again.")
        expect(
            "the consumed observation cannot be replayed",
            reasons(replayed) == "fresh_observation_required",
            reasons(replayed),
        )

        observed = controller.observe()
        denied = controller.key("enter", observed["observation_id"], "Confirm the dialog.")
        expect(
            "a key press is outside the grant",
            reasons(denied) == "owner_grant_action_denied",
            reasons(denied),
        )
        outside = controller.click(900, 700, observed["observation_id"], "Click off the window.")
        expect(
            "a click outside the window is refused by the backend",
            reasons(outside) == "pointer_outside_target_window",
            reasons(outside),
        )

        observed = controller.observe()
        clock[0] += 3.0
        stale = controller.type_text("x", observed["observation_id"], "Type with an old view.")
        expect(
            "an observation older than 2 s is stale",
            reasons(stale) == "observation_stale",
            reasons(stale),
        )

        observed = controller.observe()
        typed = controller.type_text(
            secret_text, observed["observation_id"], "Fill the name field."
        )
        print(f"  type      : reason={reasons(typed)} text_length={typed['action']['text_length']}")
        expect("typing reaches the fake host", typed["ok"] and host.typed == secret_text)
        expect(
            "the receipt carries a length and hash, not the text",
            typed["typed_text_redacted"] and secret_text not in json.dumps(typed),
        )

        clicked = controller.click(640, 420, typed["next_observation_id"], "Press Save again.")
        expect(
            "the third event is still inside the budget",
            clicked["ok"] and clicked["events_used"] == 3,
        )
        observed = controller.observe()
        spent = controller.click(640, 420, observed["observation_id"], "One click too many.")
        print(f"  4th event : reason={reasons(spent)}")
        expect(
            "the grant's event budget is exhausted",
            reasons(spent) == "owner_grant_event_limit_reached",
            reasons(spent),
        )
    finally:
        controller.close()  # releases the lease so the receipt file can be read back

    kinds = [event["kind"] for event in host.events]
    expect(
        "the fake host saw exactly click, type, click",
        kinds == ["click", "type", "click"],
        str(kinds),
    )
    durable = receipt_path.read_text(encoding="utf-8")
    rows = [json.loads(line) for line in durable.splitlines()]
    pending = sum(1 for row in rows if row["phase"] == "pending")
    terminal = sum(1 for row in rows if row["phase"] == "terminal")
    print(f"  receipts  : {pending} pending, {terminal} terminal records on disk")
    expect("every effect wrote a pending record before the terminal one", pending == terminal == 3)
    expect(
        "the durable file never contains the typed text",
        secret_text not in durable and "text_sha256" in durable,
    )
    expect("receipts name no paths or hosts", str(workdir) not in durable)


def main() -> int:
    with no_os_input(), private_workdir() as workdir:
        mediator_part(workdir)
        session_part(workdir)
    section("3. Summary")
    expect("no real OS call was attempted (subprocess and CDLL tripwires)", not TRIPWIRE_HITS)
    print(f"\ndemo finished: {len(FAILURES)} failed expectation(s)")
    for label in FAILURES:
        print(f"  FAILED: {label}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
