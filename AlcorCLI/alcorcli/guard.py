"""The turn guard: a deadline and the operator's STOP files, checked at every boundary.

A model call can take minutes and a tool call can change the world, so the gate checks two things
before it crosses either: has the operator asked everything to stop, and is there time left. The
guard is also where "the source did not change under us" is enforced for the policy programs a
turn depends on.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from .errors import TurnInterrupted


class TurnGuard:
    """Raises ``TurnInterrupted`` once the turn must not continue.

    Args:
        timeout: Seconds the whole turn may take.
        stop_paths: Files whose existence means "stop now". The operator creates them; nothing
            in this package ever does.
        pins: Files that must keep the SHA-256 they have now. If one changes mid-turn the next
            ``boundary`` call stops the turn instead of obeying a policy nobody reviewed.
        clock: Monotonic clock, injectable for tests.
    """

    def __init__(
        self,
        timeout: float,
        stop_paths: Sequence[Path | str] = (),
        pins: Mapping[Path, str] | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._clock = clock
        self.deadline = clock() + timeout
        self.stop_paths = [Path(p).expanduser() for p in stop_paths]
        self.pins = dict(pins or {})
        # Bookkeeping for the agent loop, kept here so an interruption can close exactly the tool
        # transaction that was open: ``pending`` maps call id to tool name, ``executing`` is the
        # call whose handler was running, ``receipts`` is the turn's per-call record.
        self.pending: dict[str, str] = {}
        self.executing: str | None = None
        self.receipts: list[dict[str, object]] = []

    @staticmethod
    def pin(path: Path) -> str:
        """Return the SHA-256 of a file, for use in ``pins``."""
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def check(self) -> float:
        """Return the seconds left, or raise if the operator stopped the turn or time is up."""
        for path in self.stop_paths:
            try:
                path.lstat()  # A dangling STOP symlink still counts as a stop request.
            except FileNotFoundError:
                continue
            except OSError as exc:
                # Not being able to look is not the same as nothing being there. Fail closed.
                raise TurnInterrupted("agent-control-unavailable") from exc
            raise TurnInterrupted("agent-owner-stop")
        remaining = self.deadline - self._clock()
        if remaining <= 0:
            raise TurnInterrupted("agent-turn-deadline")
        return remaining

    def boundary(self) -> float:
        """Run before crossing into a model call, a tool call or a ledger write.

        Does everything ``check`` does, and also confirms every pinned file is unchanged.
        """
        self.check()
        for path, digest in self.pins.items():
            try:
                changed = self.pin(path) != digest
            except OSError as exc:
                raise TurnInterrupted("agent-source-unavailable") from exc
            if changed:
                raise TurnInterrupted("agent-source-changed", path.name)
        return self.check()
