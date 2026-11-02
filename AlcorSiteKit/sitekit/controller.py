"""The host-side controller: applies the release the pointer log names, if and only if it may.

It runs where production lives. In the private deployment it was a root-owned cron job that woke
every two minutes; here it is ``sitekit controller run --watch``. It trusts nothing the operator
sends except what it can check itself:

* the pointer log's hash chain must verify;
* a release that has never been live needs a one-time approval code whose hash is in the
  controller's own store, and the code is burned on first use even if the deploy then fails;
* a release that was live before, or the pre-controller site, needs no code, so an emergency undo
  is never blocked by an absent approver (a code presented anyway is still spent);
* every file is verified before and after the swap, and a failed smoke check puts the previous
  release back (see ``deploy``).

Each pointer entry gets exactly one attempt. A refused or failed entry is not retried by waiting;
a new ``promote`` appends a new entry and therefore gets a new attempt.

State lives in ``controller_dir``: ``approval-codes`` (hashes), ``current.json`` (what is live),
``handled.json`` (the last entry attempted), ``receipts.jsonl`` (every attempt), ``STOP`` (create
it to pause the controller) and ``lock``. The public status document is written into the host's
``.releases`` folder, where the web server publishes it.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .approvals import ApprovalStore
from .deploy import HostPaths, apply_release, make_smoke, restore_initial
from .fsutil import (
    FileLock,
    LockTimeout,
    canonical,
    read_json,
    sha256_file,
    utc_now,
    write_json_atomic,
)
from .release import COMMIT_RE
from .repo import INITIAL, ChainError, ReleaseRepo, short

# States a waiting ``promote`` stops on. "deploying" is in between and is never final.
TERMINAL_STATES = frozenset({"live", "needs-approval", "failed-restored"})


@dataclass(frozen=True)
class ControllerConfig:
    """Everything the controller needs; it never reads the operator's configuration."""

    production_dir: Path
    controller_dir: Path
    repo_dir: Path
    base_url: str
    smoke_pages: tuple[str, ...] = ("/",)
    unserved: tuple[str, ...] = ()


class Controller:
    """Reads the pointer log and makes production match it, subject to the rules above."""

    def __init__(self, cfg: ControllerConfig) -> None:
        self.cfg = cfg
        self.repo = ReleaseRepo(cfg.repo_dir)
        self.approvals = ApprovalStore(cfg.controller_dir / "approval-codes")
        self.paths = HostPaths(cfg.production_dir)
        self._state = cfg.controller_dir
        self._self_sha = sha256_file(Path(__file__))

    def run_once(self) -> str:
        """Look at the pointer log once and act on its newest entry.

        Returns:
            One of ``idle`` (nothing new), ``busy`` (another controller holds the lock),
            ``stopped`` (the STOP file exists), ``already-live``, ``needs-approval``,
            ``log-rejected``, ``failed-restored`` or ``live``.
        """
        lock = FileLock(self._state / "lock")
        try:
            lock.acquire()
        except LockTimeout:
            return "busy"
        try:
            return self._decide()
        finally:
            lock.release()

    def watch(self, interval: float) -> None:
        """Call ``run_once`` forever, ``interval`` seconds apart (the cron job's job).

        An unexpected error is logged and the loop continues: a watcher that dies on one bad tick
        would silently stop every later release, and every decision it makes is idempotent.
        """
        while True:
            try:
                self.run_once()
            except Exception as error:
                print(
                    f"controller: error {type(error).__name__}: {self._scrub(str(error))}",
                    flush=True,
                )
            time.sleep(interval)

    # -- decision ---------------------------------------------------------------------------

    def _decide(self) -> str:
        if (self._state / "STOP").exists():
            return "stopped"
        handled = read_json(self._state / "handled.json", {})
        try:
            entries = self.repo.pointer_entries()
        except ChainError as error:
            # Someone edited history. Act on none of it, and say so where the operator looks.
            self._report_rejected(str(error))
            return "log-rejected"
        # The hash chain cannot see an edit to its newest line (nothing commits to it yet), but
        # this controller remembers the last entry it acted on, which anchors the chain: that
        # entry must still be in the log, unchanged.
        if handled.get("entry") and all(e["id"] != handled["entry"] for e in entries):
            self._report_rejected("an entry already acted on is missing or was edited")
            return "log-rejected"
        head = entries[-1] if entries else None
        if read_json(self.paths.status, {}).get("state") == "log-rejected":
            self._publish("idle", head)  # the log verifies again: stop reporting the rejection
        if head is None:
            return "idle"
        if handled.get("entry") == head["id"]:
            return "idle"
        # A presented code is spent whether or not this entry needs one. The code travels in the
        # pointer log, so leaving it valid would leave a usable secret in the audit trail.
        accepted = self.approvals.redeem(head.get("approval_code"))
        target = head["target"]
        if target != INITIAL and not COMMIT_RE.fullmatch(str(target)):
            return self._fail(head, "pointer target is not a commit id")
        current = read_json(self._state / "current.json", {})
        if target != INITIAL and current.get("target") == target:
            # Nothing to deploy, but a waiting `promote` still needs an answer for this entry.
            self._mark_handled(head)
            self._publish("live", head, "already live; nothing to do")
            return "already-live"
        if not (accepted or target == INITIAL or self._was_live(target)):
            return self._refuse(head)
        self._publish("deploying", head)
        try:
            result = self._apply(target)
        except Exception as error:
            return self._fail(head, str(error) or type(error).__name__)
        self._succeed(head, result, current)
        return "live"

    def _report_rejected(self, detail: str) -> None:
        """Publish a rejected log once, not on every tick of the watch loop."""
        status = read_json(self.paths.status, {})
        if status.get("state") != "log-rejected" or status.get("detail") != detail:
            self._publish("log-rejected", None, detail)

    def _refuse(self, head: dict[str, Any]) -> str:
        """Record and publish a release refused for lack of a valid approval code."""
        detail = "approval code missing or not valid; production is unchanged"
        self._receipt(head, ok=False, error=detail)
        self._mark_handled(head)
        self._publish("needs-approval", head, detail)
        return "needs-approval"

    def _was_live(self, target: str) -> bool:
        receipts = self._state / "receipts.jsonl"
        if not receipts.is_file():
            return False
        for line in receipts.read_text(encoding="utf-8").splitlines():
            row = _parse_object(line)
            if row.get("ok") is True and row.get("target") == target:
                return True
        return False

    def _apply(self, target: str) -> dict[str, Any]:
        if target == INITIAL:
            smoke = make_smoke(self.cfg.base_url, None, ("/",))
            return restore_initial(self.cfg.production_dir, smoke=smoke)
        release = self.repo.load_release(target)
        smoke = make_smoke(self.cfg.base_url, release, self.cfg.smoke_pages, self.cfg.unserved)
        return apply_release(
            self.cfg.production_dir, release, self.repo.files_dir(target), smoke=smoke
        )

    # -- outcomes ---------------------------------------------------------------------------

    def _succeed(
        self, head: dict[str, Any], result: dict[str, Any], before: dict[str, Any]
    ) -> None:
        target = head["target"]
        if target == INITIAL:
            (self._state / "current.json").unlink(missing_ok=True)
        else:
            write_json_atomic(
                self._state / "current.json",
                {
                    "target": target,
                    "entry": head["id"],
                    "applied_at": utc_now(),
                    "previous": before.get("target"),
                },
            )
        self._receipt(head, **result)  # result already carries ok=True
        self._mark_handled(head)
        self._publish("live", head)

    def _fail(self, head: dict[str, Any], error: str) -> str:
        detail = self._scrub(error)
        self._receipt(head, ok=False, error=detail)
        self._mark_handled(head)
        self._publish("failed-restored", head, detail)
        return "failed-restored"

    def _mark_handled(self, head: dict[str, Any]) -> None:
        write_json_atomic(self._state / "handled.json", {"entry": head["id"], "seq": head["seq"]})

    def _receipt(self, head: dict[str, Any], **fields: Any) -> None:
        """Append one line per attempt: what was asked, what happened, which code decided it."""
        row = {
            "seq": head["seq"],
            "entry": head["id"],
            "target": head["target"],
            "at": utc_now(),
            "controller_sha256": self._self_sha,
            **fields,
        }
        self._state.mkdir(parents=True, exist_ok=True)
        with (self._state / "receipts.jsonl").open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(canonical(row) + "\n")

    def _publish(self, state: str, head: dict[str, Any] | None, detail: str = "") -> None:
        """Write the status document the operator reads over HTTP, and log the transition.

        ``live`` and ``previous`` always describe what production serves, whatever the latest
        attempt was, so a refused attempt never hides the release that is actually live.
        """
        current = read_json(self._state / "current.json", {})
        status = {
            "state": state,
            "target": head["target"] if head else None,
            "entry": head["id"] if head else None,
            "seq": head["seq"] if head else None,
            "detail": self._scrub(detail),
            "live": current.get("target"),
            "previous": current.get("previous"),
            "at": utc_now(),
        }
        write_json_atomic(self.paths.status, status, indent=None)
        target = short(status["target"]) if status["target"] else "-"
        print(f"controller: {state} {target} {status['detail']}".rstrip(), flush=True)

    def _scrub(self, text: str) -> str:
        """Replace this machine's folder names in a message that will be published over HTTP."""
        roots = (
            (self.cfg.production_dir, "<host>"),
            (self.cfg.controller_dir, "<state>"),
            (self.cfg.repo_dir, "<repo>"),
        )
        for root, label in roots:
            for variant in {str(root), root.as_posix(), str(root).replace("\\", "\\\\")}:
                text = text.replace(variant, label)
        return text[-400:]


def _parse_object(text: str) -> dict[str, Any]:
    """Parse one JSON object from a log line; return ``{}`` if the line is not one."""
    try:
        value = json.loads(text)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}
