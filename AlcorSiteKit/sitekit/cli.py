"""sitekit: one command that lands a change on staging, proves it, reviews it and promotes it.

Verbs, grouped by who runs them. Long verbs take --detach: they return a job id at once and the
result is read later with `sitekit job ID`.

Operator, read-only and quick
  status                    what staging and production serve, the last contract, holds, jobs
  review                    merge visual diffs, weak cold reads and contract failures into one pack
  jobs | job ID             list detached jobs, or show one job's log tail and result

Operator, long
  land SOURCE               put a source folder (or an earlier release id) on staging and gate it
  contract [--only a,b] [--prod]   run the standing suites and write a sealed receipt
  visual [--approve]        compare screenshots with the approved baseline (needs Playwright)
  coldread                  stranger test of the pages, with a swappable model
  promote [--go --approved ID --code CODE]
                            readiness; with --go, ship staging's exact commit through the gate
  rollback [--to SHA|initial]   put production back; no code for a release that was live before

Approver
  approve [--count N]       mint one-time approval codes (shown once, stored as hashes)

Host
  controller run [--watch]  apply what the pointer log says, enforcing the approval rule

Settings come from a JSON file and SITEKIT_* environment variables (see README).
"""

from __future__ import annotations

import argparse
import contextlib
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import gate, jobs
from .approvals import ApprovalStore
from .coldread import (
    ColdReadError,
    capture_text,
    load_intended,
    load_model,
    normalize_pages,
    run_reads,
    write_report,
)
from .config import Config, ConfigError, load_config
from .contract import ContractError, run_contract
from .controller import TERMINAL_STATES, Controller, ControllerConfig
from .deploy import DeployError
from .fsutil import FileLock, LockTimeout, read_json, sha256_bytes, write_json_atomic
from .net import controller_status, fetch, head, served_commit
from .receipts import read_sealed
from .release import COMMIT_RE, Release, ReleaseError
from .repo import INITIAL, ChainError, ReleaseRepo, RepoError, short
from .sitescan import crawl
from .transport import load_transport

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
KNOWN_ERRORS = (
    ColdReadError,
    ContractError,
    DeployError,
    LockTimeout,
    ReleaseError,
    RepoError,
)
EXIT_NOTHING_TO_LAND = 8
EXIT_STAGING_TIMEOUT = 6
EXIT_GATE_FAIL = 7


def _fail(message: str, code: int = 1) -> int:
    print(message, file=sys.stderr, flush=True)
    return code


def _production_state(production: str) -> tuple[str, dict[str, Any]]:
    """Return ``(release header, controller status)`` for production."""
    return head(production)[1], controller_status(production)


def _pages_for(cfg: Config, url: str, explicit: str | None) -> list[str]:
    """Pick the pages to capture: the ones named, the configured ones, else everything linked."""
    if explicit:
        return normalize_pages(explicit.split(","))
    if cfg.pages:
        return list(cfg.pages)
    crawled = crawl(url, max_pages=20)
    pages = sorted(p for p, page in crawled.items() if page.status == 200 and page.scan)
    if not pages:
        # A check over zero pages would pass; refuse instead of reporting an empty success.
        raise ConfigError("no pages found to check: is staging reachable? Give --pages or `pages`")
    return pages


def _show(path: Path, home: Path) -> str:
    """Format a path relative to the state folder, so output never carries machine paths."""
    try:
        return path.relative_to(home).as_posix()
    except ValueError:
        return path.name


# -- read-only verbs --------------------------------------------------------------------------


def cmd_status(cfg: Config, args: argparse.Namespace) -> int:
    """Print what staging and production serve and the state of the last contract."""
    staging, production = cfg.require("staging_url"), cfg.require("production_url")
    s_code, s_commit = head(staging)
    p_code, p_sha = head(production)
    state = controller_status(production)
    print(f"staging     http={s_code} serves={s_commit[:8] or '?'}")
    print(
        f"production  http={p_code} release={p_sha[:8] or '(pre-controller)'} "
        f"controller={state.get('state', 'no status')}"
    )
    try:
        entries = ReleaseRepo(cfg.repo_dir).pointer_entries()
        if entries:
            head_target = short(entries[-1]["target"])
            print(f"pointer     {len(entries)} entries, head -> {head_target} (chain verified)")
        else:
            print("pointer     empty: nothing promoted yet")
    except ChainError as error:
        print(f"pointer     BROKEN: {error}")
    receipt, problem = read_sealed(cfg.receipts / "latest.json")
    if receipt:
        stale = "" if receipt["served_commit"] == s_commit else "  (older than what staging serves)"
        verdict = "GREEN" if receipt["green"] else "RED"
        print(
            f"contract    {verdict} {receipt['pass']} pass / {receipt['fail']} fail at "
            f"{receipt['at']} on {receipt['served_commit'][:8]}{stale}"
        )
    elif (cfg.receipts / "latest.json").exists():
        print(f"contract    receipt not trusted: {problem}")
    else:
        print("contract    never run here: `sitekit contract`")
    hold = gate.read_hold(cfg.hold_file)
    print(f"hold        {'none' if hold is None else 'ON: ' + hold}")
    running = jobs.running(cfg.jobs)
    print(f"jobs        {', '.join(running) if running else 'none running'}")
    return 0


def cmd_jobs(cfg: Config, args: argparse.Namespace) -> int:
    """List the newest detached jobs."""
    rows = jobs.listing(cfg.jobs)
    if not rows:
        print("no jobs yet")
    for name, state in rows:
        print(f"{name:<32} {state}")
    return 0


def cmd_job(cfg: Config, args: argparse.Namespace) -> int:
    """Show one job's log tail and result."""
    found = jobs.show(cfg.jobs, args.id, args.lines)
    if found is None:
        return _fail(f"no job {args.id}")
    tail, state = found
    print(tail)
    print(f"\n[{args.id}] {state.upper() if state == 'running' else 'DONE ' + state}")
    return 0


def cmd_review(cfg: Config, args: argparse.Namespace) -> int:
    """Merge visual diffs, weak cold reads and failed contract suites into one review pack."""
    items: list[dict[str, Any]] = []
    for source in ("visual", "coldread"):
        pack = read_json(cfg.home / source / "latest-review.json", {})
        items += [{**item, "source": source} for item in pack.get("items", [])]
    receipt, _ = read_sealed(cfg.receipts / "latest.json")
    for suite in (receipt or {}).get("suites", []):
        if not suite["ok"]:
            items.append(
                {
                    "source": "contract",
                    "path": "/",
                    "width": 1440,
                    "body": f"Contract suite {suite['suite']} has {suite['fail']} FAIL on "
                    f"{receipt['served_commit'][:8]}: see {receipt['logs']}/{suite['suite']}.txt",
                }
            )
    out = cfg.home / "review" / "latest.json"
    write_json_atomic(out, {"items": items})
    if not items:
        print("review: nothing to review (no visual changes, no weak cold reads, contract green).")
        return 0
    print(f"review: {len(items)} finding(s) -> {_show(out, cfg.home)}")
    for item in items:
        print(f"- [{item['source']}] {item['path']} @{item['width']}: {item['body'][:220]}")
    return 0


# -- landing and testing ----------------------------------------------------------------------


def _release_from(source: str, repo: ReleaseRepo) -> Release:
    """Turn the ``land`` argument into a release held by the repository.

    A folder is hashed and copied in. A 40-hex id re-lands an earlier release, which is how a
    change is reverted: staging is simply pointed back at content that already passed.
    """
    if COMMIT_RE.fullmatch(source):
        return repo.load_release(source)
    folder = Path(source)
    if not folder.is_dir():
        raise ReleaseError(f"{source!r} is neither a folder nor a release id")
    release = Release.from_dir(folder)
    repo.put_release(release, folder)
    return release


def _verify_served(staging: str, release: Release, unserved: Sequence[str] = ()) -> int:
    """Gate: every released file is served byte for byte (0 = pass).

    ``unserved`` lists file-name suffixes the host refuses to serve by design; they are skipped.
    """
    stamp = time.time_ns()
    bad = []
    for name, expected in release.files.items():
        if name.endswith(tuple(unserved)):
            continue
        status, body, _ = fetch(f"{staging}/{name}?sitekit_check={stamp}")
        if status != 200 or sha256_bytes(body) != expected:
            bad.append(f"{name} (HTTP {status})")
    for entry in bad[:8]:
        print(f"FAIL served-files {entry}")
    if not bad:
        print(f"PASS served-files: {len(release.files)} files match the release")
    return 1 if bad else 0


def cmd_land(cfg: Config, args: argparse.Namespace) -> int:
    """Put a source folder (or an earlier release id) on staging, wait for it, run the gates."""
    staging = cfg.require("staging_url")
    repo = ReleaseRepo(cfg.repo_dir)
    transport = load_transport(cfg)
    # One land at a time: two interleaved swaps would leave staging serving a mixture.
    with FileLock(cfg.home / "land.lock", timeout=args.lock_wait):
        release = _release_from(args.source, repo)
        if served_commit(staging) == release.commit:
            return _fail(
                f"NOTHING_TO_LAND: staging already serves {release.commit[:8]}",
                EXIT_NOTHING_TO_LAND,
            )
        transport.push(release, repo.files_dir(release.commit))
        print(f"PUSHED release={release.commit[:8]} files={len(release.files)}", flush=True)
        deadline = time.monotonic() + cfg.wait_seconds
        while served_commit(staging) != release.commit:
            if time.monotonic() > deadline:
                return _fail("STAGING_TIMEOUT", EXIT_STAGING_TIMEOUT)
            time.sleep(cfg.poll_seconds)
        print(f"STAGING serves {release.commit[:8]}", flush=True)
        served = _verify_served(staging, release, cfg.unserved)
        suite = 0
        if args.suite:
            suite = (
                0
                if run_contract(cfg.contract_file, cfg.home, staging, only=args.suite)["green"]
                else 1
            )
        print(f"GATES served={served} suite={suite} head={release.commit[:8]}")
        if served == 0 and suite == 0:
            print("LANDED")
            return 0
    return _fail(
        "GATE_FAIL (staging now serves this; fix forward, or land the previous release id again)",
        EXIT_GATE_FAIL,
    )


def cmd_contract(cfg: Config, args: argparse.Namespace) -> int:
    """Run the standing suites against staging (or, with --prod, production's read-only set)."""
    url = cfg.require("production_url" if args.prod else "staging_url")
    receipt = run_contract(
        cfg.contract_file, cfg.home, url, only=args.only, prod=args.prod, timeout=args.timeout
    )
    return 0 if receipt["green"] else 1


def _node_script(name: str) -> list[str]:
    node = shutil.which("node")
    if node is None:
        raise ConfigError("this verb needs Node.js and Playwright; see the README section on it")
    return [node, str(PACKAGE_ROOT / "browser" / name)]


def cmd_visual(cfg: Config, args: argparse.Namespace) -> int:
    """Compare screenshots with the approved baseline, or approve the current ones as baseline."""
    url = cfg.require("staging_url")
    pages = _pages_for(cfg, url, args.pages)
    command = [
        *_node_script("visual.mjs"),
        url,
        "--approve" if args.approve else "--compare",
        "--pages",
        ",".join(pages),
    ]
    return subprocess.run(
        command, env={**os.environ, "SITEKIT_HOME": str(cfg.home)}, check=False
    ).returncode


def cmd_coldread(cfg: Config, args: argparse.Namespace) -> int:
    """Capture the pages, have a model read and judge them, and write the report."""
    url = cfg.require("staging_url")
    intended = load_intended(cfg.intended_file)
    model = load_model(args.judge)
    pages = _pages_for(cfg, url, args.pages)
    capture = cfg.home / "coldread" / time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    if args.capture == "browser":
        capture.mkdir(parents=True, exist_ok=True)
        command = [*_node_script("capture.mjs"), url, str(capture), "--pages", ",".join(pages)]
        done = subprocess.run(
            command, env={**os.environ, "SITEKIT_HOME": str(cfg.home)}, check=False
        )
        if done.returncode:
            return done.returncode
    else:
        capture_text(url, pages, capture)
    rows = run_reads(capture, model, intended, personas=args.personas, jobs=args.jobs)
    items = write_report(capture, rows, model.name)
    write_json_atomic(
        cfg.home / "coldread" / "latest-review.json", {"source": "coldread", "items": items}
    )
    print(f"wrote {_show(capture / 'REPORT.md', cfg.home)} ({len(items)} page(s) flagged)")
    return 0


# -- promotion --------------------------------------------------------------------------------


def _approval_code(args: argparse.Namespace) -> str | None:
    """Read the code from --code, from stdin (--code -) or from SITEKIT_APPROVAL_CODE."""
    if args.code == "-":
        return sys.stdin.readline().strip() or None
    return args.code or os.environ.get("SITEKIT_APPROVAL_CODE") or None


def _await_controller(cfg: Config, entry: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Wait until the controller reports a final state for ``entry``."""
    production = cfg.require("production_url")
    deadline = time.monotonic() + cfg.wait_seconds
    status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status = controller_status(production)
        if status.get("entry") == entry["id"] and status.get("state") in TERMINAL_STATES:
            return str(status["state"]), status
        time.sleep(cfg.poll_seconds)
    return "timeout", status


def _finish(cfg: Config, entry: dict[str, Any], done_word: str) -> int:
    """Report the controller's verdict on ``entry`` and, if it went live, check production."""
    production = cfg.require("production_url")
    target = entry["target"]
    label = "the pre-controller site" if target == INITIAL else target[:8]
    state, status = _await_controller(cfg, entry)
    if state == "live":
        header = head(production)[1]
        print(f"controller: live on {label} (header {header[:8] or 'none'})", flush=True)
        if target == INITIAL:
            return 0 if not header else _fail("production still names a release after the restore")
        if header != target:
            return _fail("production's header does not name the commit that was promoted")
        receipt = run_contract(cfg.contract_file, cfg.home, production, prod=True)
        if receipt["green"]:
            print(f"{done_word} {label}")
            return 0
        return _fail(
            f"production is live on {label} but its read-only contract is RED; "
            "consider `sitekit rollback`"
        )
    if state == "needs-approval":
        return _fail(
            "the controller refused: the approval code is missing or not valid. "
            "Production is unchanged."
        )
    if state == "failed-restored":
        return _fail(
            "the controller rejected the release and restored the previous one: "
            f"{status.get('detail', '')}"
        )
    seen = status.get("state")
    note = f"; its last state was {seen!r}: {status.get('detail', '')}" if seen else ""
    return _fail(
        f"timed out waiting for the controller{note} (is `sitekit controller run --watch` running?)"
    )


def cmd_promote(cfg: Config, args: argparse.Namespace) -> int:
    """Report readiness; with --go, ship staging's exact commit if the gate allows it."""
    staging, production = cfg.require("staging_url"), cfg.require("production_url")
    _, s_commit = head(staging)
    receipt, problem = read_sealed(cfg.receipts / "latest.json")
    checks = gate.readiness(s_commit, receipt, problem)
    for check in checks:
        print(check.line())
    hold = gate.read_hold(cfg.hold_file)
    if hold is not None:
        print("HOLD " + hold)
    sha, state = _production_state(production)
    print(
        f"production now: release {sha[:8] or '(pre-controller)'}, "
        f"controller {state.get('state', 'no status yet')}"
    )
    if not args.go:
        if gate.shippable(checks, hold):
            print(
                "\nTo ship: sitekit promote --go --approved ID --code CODE   "
                "(an approval id and a one-time code from the approver)"
            )
            return 0
        held_only = hold is not None and all(check.ok for check in checks)
        print(
            "\nOn hold: --go refuses until the hold file is removed."
            if held_only
            else "\nNot ready."
        )
        return 1
    code = _approval_code(args)
    refusal = gate.refusal(checks, hold, code, args.approved)
    if refusal is not None:
        return _fail(f"refused [{refusal.reason}]: {refusal.message}")
    repo = ReleaseRepo(cfg.repo_dir)
    if not repo.has_release(s_commit):
        return _fail(
            f"refused [release-missing]: staging serves {s_commit[:8]}, which the release "
            "repository does not hold; land it with `sitekit land`."
        )
    proof = f"{receipt['pass']} pass, receipt {receipt['at']}" if receipt else "no receipt"
    why = f"Promoted by sitekit. Approval {args.approved}. Contract green: {proof}."
    entry = repo.append_pointer(s_commit, why, approval_id=args.approved, approval_code=code)
    print(f"pointer moved (#{entry['seq']}): production -> {s_commit[:8]}", flush=True)
    return _finish(cfg, entry, "PROMOTED")


def cmd_rollback(cfg: Config, args: argparse.Namespace) -> int:
    """Point production back at the previous release, a named one, or the pre-controller site."""
    production = cfg.require("production_url")
    _, state = _production_state(production)
    if state.get("state") == "deploying":
        return _fail("refused: a release is being applied right now")
    if args.to == "initial":
        target = INITIAL
    elif args.to:
        if not COMMIT_RE.fullmatch(args.to):
            return _fail("--to takes a full 40-character commit id, or 'initial'")
        target = args.to
    elif state.get("live"):
        target = state.get("previous") or INITIAL
    else:
        return _fail("refused [nothing-to-roll-back]: the controller reports no live release")
    entry = ReleaseRepo(cfg.repo_dir).append_pointer(target, f"Rollback by sitekit: {args.why}")
    print(f"pointer moved (#{entry['seq']}): production -> {short(target)}", flush=True)
    return _finish(cfg, entry, "ROLLED BACK TO")


# -- approver and host ------------------------------------------------------------------------


def cmd_approve(cfg: Config, args: argparse.Namespace) -> int:
    """Mint one-time approval codes. Run by the approver, not by the release operator."""
    store = ApprovalStore(cfg.controller_dir / "approval-codes")
    if args.remaining:
        print(store.remaining())
        return 0
    for code in store.mint(args.count):
        print(code)
    print(
        f"{args.count} code(s) shown once; only their hashes are stored "
        f"({store.remaining()} unused in total).",
        file=sys.stderr,
    )
    return 0


def cmd_controller(cfg: Config, args: argparse.Namespace) -> int:
    """Run the host-side controller once, or keep running with --watch."""
    controller = Controller(
        ControllerConfig(
            production_dir=cfg.production_dir,
            controller_dir=cfg.controller_dir,
            repo_dir=cfg.repo_dir,
            base_url=cfg.require("production_url"),
            smoke_pages=cfg.smoke_pages,
            unserved=cfg.unserved,
        )
    )
    if not args.watch:
        print(controller.run_once())
        return 0
    with contextlib.suppress(KeyboardInterrupt):  # Ctrl-C is the normal way to stop a watcher
        controller.watch(args.interval or cfg.poll_seconds)
    return 0


# -- plumbing ---------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser for every verb."""
    parser = argparse.ArgumentParser(
        prog="sitekit", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--config", help="config file (default: SITEKIT_CONFIG, then <home>/config.json)"
    )
    sub = parser.add_subparsers(dest="cmd", required=True, metavar="verb")

    def verb(name: str, func: Any, help_text: str, detach: bool = False) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text, description=help_text)
        p.set_defaults(func=func)
        if detach:
            p.add_argument(
                "--detach", action="store_true", help="run in the background, print a job id"
            )
        return p

    verb("status", cmd_status, "what staging and production serve")
    verb("jobs", cmd_jobs, "list detached jobs")
    p = verb("job", cmd_job, "show one job's log tail and result")
    p.add_argument("id")
    p.add_argument("--lines", type=int, default=40)
    verb("review", cmd_review, "merge findings into one review pack")
    p = verb("land", cmd_land, "land a source folder (or release id) on staging", detach=True)
    p.add_argument("source")
    p.add_argument("--suite", help="also run this contract suite as a landing gate")
    p.add_argument(
        "--lock-wait", type=float, default=600.0, help="seconds to wait for another land"
    )
    p = verb("contract", cmd_contract, "run the standing suites", detach=True)
    p.add_argument(
        "--only", help="comma-separated suite names (the receipt will not be 'complete')"
    )
    p.add_argument("--prod", action="store_true", help="production's read-only suites only")
    p.add_argument("--timeout", type=float, default=1800.0, help="seconds before a suite is killed")
    p = verb("visual", cmd_visual, "visual baseline (needs Playwright)", detach=True)
    p.add_argument(
        "--approve", action="store_true", help="make the current screenshots the baseline"
    )
    p.add_argument("--pages", help="comma-separated paths (default: everything linked from /)")
    p = verb("coldread", cmd_coldread, "stranger test of the pages", detach=True)
    p.add_argument("--pages", help="comma-separated pages, e.g. home,menu")
    p.add_argument("--personas", type=int, default=3)
    p.add_argument("--jobs", type=int, default=3)
    p.add_argument("--judge", default="keyword", help="keyword | claude[:model] | module:Class")
    p.add_argument("--capture", choices=["text", "browser"], default="text")
    p = verb("promote", cmd_promote, "readiness, or ship with --go", detach=True)
    p.add_argument("--go", action="store_true")
    p.add_argument("--approved", help="id of the approval record that authorised this release")
    p.add_argument("--code", help="one-time approval code ('-' reads it from stdin)")
    p = verb("rollback", cmd_rollback, "put production back", detach=True)
    p.add_argument("--to", help="a full commit id, or 'initial' for the pre-controller site")
    p.add_argument("--why", default="operator rollback")
    p = verb("approve", cmd_approve, "mint one-time approval codes (approver only)")
    p.add_argument("--count", type=int, default=5)
    p.add_argument("--remaining", action="store_true", help="print how many codes are unused")
    p = verb("controller", cmd_controller, "run the host-side controller")
    p.add_argument("action", choices=["run"])
    p.add_argument("--watch", action="store_true", help="keep running, checking the pointer log")
    p.add_argument("--interval", type=float, help="seconds between checks with --watch")
    return parser


def _detach(cfg: Config, kind: str, raw: list[str]) -> int:
    """Start the verb as a background job, keeping any approval code out of the job record."""
    argv: list[str] = []
    env: dict[str, str] = {}
    tokens = iter(raw)
    for token in tokens:
        if token == "--detach":
            continue
        if token == "--code":
            value = next(tokens, "")
            env["SITEKIT_APPROVAL_CODE"] = sys.stdin.readline().strip() if value == "-" else value
        elif token.startswith("--code="):
            env["SITEKIT_APPROVAL_CODE"] = token.partition("=")[2]
        else:
            argv.append(token)
    job_id = jobs.start(cfg.jobs, kind, argv, env)
    print(f"started job {job_id}\n  check: sitekit job {job_id}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Run one sitekit command and return its exit code."""
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw[:1] == ["_jobrun"]:  # internal: a detached job re-enters here with its record folder
        return jobs.record_run(Path(raw[1]), lambda: main(raw[2:]))
    args = build_parser().parse_args(raw)
    try:
        cfg = load_config(args.config)
        if getattr(args, "detach", False):
            return _detach(cfg, args.cmd, raw)
        return int(args.func(cfg, args) or 0)
    except ConfigError as error:
        return _fail(f"config: {error}", 2)
    except KNOWN_ERRORS as error:
        return _fail(f"error: {error}")


if __name__ == "__main__":
    raise SystemExit(main())
