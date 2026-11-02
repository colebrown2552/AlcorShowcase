"""The promote gate: the one place that decides whether production may move.

``promote --go`` is refused unless every condition below holds. They are checked in this order,
and the first failure is the reason reported:

1. Staging serves a commit. The commit names exactly what is deployed there.
2. The contract receipt is for that commit. A green run on older code proves nothing about newer
   code, so a receipt for any other commit does not count, and neither does one whose seal fails.
3. That receipt is green and covers the whole contract, not a hand-picked subset of suites.
4. No hold file exists. Creating the file freezes releases; removing it is a human act.
5. An approval code is supplied. This module only requires that one is present; whether it is
   valid and unused is decided by the controller on the host, where the hashes live.
6. An approval id is supplied. It names the approval record that authorised this release, so a
   line in the release log can be traced back to a decision.

Conditions 1 to 3 are the readiness checks ``promote`` prints without ``--go``. Nothing here
touches the network or the disk; the CLI gathers the inputs and acts on the answer.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any, NamedTuple

# Not tied to any tracker: three to sixty-four characters that are safe in a log line and a shell.
APPROVAL_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{2,63}")


class Check(NamedTuple):
    """One readiness check: its name, whether it holds and, if not, why."""

    name: str
    ok: bool
    why: str

    def line(self) -> str:
        """Format the check the way ``promote`` prints it."""
        return f"{'ok  ' if self.ok else 'TODO'} {self.name}{'' if self.ok else ' - ' + self.why}"


class Refusal(NamedTuple):
    """Why ``promote --go`` was refused: a stable code for scripts and a sentence for people."""

    reason: str
    message: str


def readiness(
    staging_commit: str, receipt: Mapping[str, Any] | None, receipt_problem: str = ""
) -> list[Check]:
    """Evaluate conditions 1 to 3.

    Args:
        staging_commit: the commit staging serves right now ("" if it names none).
        receipt: the latest sealed contract receipt, or None if there is no trustworthy one.
        receipt_problem: why ``receipt`` is None (missing, seal mismatch), shown to the operator.

    Returns:
        The three checks in order, each with its verdict and failure reason.
    """
    r = receipt or {}
    receipt_commit = str(r.get("served_commit", "none"))
    stale = receipt_problem or f"receipt is for {receipt_commit[:8]}: run `sitekit contract`"
    green = bool(r.get("green"))
    complete = bool(r.get("complete"))
    if not r:
        not_green = "no contract receipt to read"
    elif green and not complete:
        not_green = "only some suites ran: run `sitekit contract` without --only"
    else:
        not_green = f"{r.get('fail', '?')} fails in {r.get('logs', 'no receipt')}"
    return [
        Check(
            "staging serves a commit",
            bool(staging_commit),
            staging_commit[:8] or "no X-Sitekit-Commit header",
        ),
        Check(
            "contract receipt is for that commit",
            bool(staging_commit) and r.get("served_commit") == staging_commit,
            stale,
        ),
        Check("contract is GREEN", green and complete, not_green),
    ]


def read_hold(path: Path) -> str | None:
    """Return the hold file's text if the file exists, else None.

    An empty hold file still holds: the file's existence is the signal, its text is the reason.
    """
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8").strip() or "(no reason given)"


def shippable(checks: list[Check], hold: str | None) -> bool:
    """Return True if conditions 1 to 4 hold, i.e. ``--go`` would get as far as the code check."""
    return all(check.ok for check in checks) and hold is None


def refusal(
    checks: list[Check], hold: str | None, code: str | None, approval_id: str | None
) -> Refusal | None:
    """Decide ``promote --go``: None means every condition holds, otherwise the first reason.

    Args:
        checks: the output of ``readiness``.
        hold: the hold file's text, or None if there is no hold file.
        code: the approval code the operator supplied, if any.
        approval_id: the approval id the operator supplied, if any.
    """
    if not all(check.ok for check in checks):
        return Refusal("not-ready", "not ready (see above).")
    if hold is not None:
        return Refusal("on-hold", f"on hold: {hold}")
    if not code:
        return Refusal(
            "approval-code-missing", "--code needs a one-time approval code from the approver."
        )
    if not approval_id or not APPROVAL_ID_RE.fullmatch(approval_id):
        return Refusal(
            "approval-id-missing", "--approved needs the id of the approval record, e.g. APPR-0042."
        )
    return None
