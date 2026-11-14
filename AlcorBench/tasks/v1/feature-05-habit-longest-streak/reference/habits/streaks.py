"""Streaks: runs of consecutive calendar days on which a habit was done."""
import datetime
from dataclasses import dataclass
from typing import Optional

ONE_DAY = datetime.timedelta(days=1)


@dataclass(frozen=True)
class Streak:
    length: int
    start: Optional[datetime.date] = None  # first day of the run
    end: Optional[datetime.date] = None    # last day of the run

    def __bool__(self):
        return self.length > 0


NO_STREAK = Streak(0)


def current_streak(days, today):
    """The run that is still alive on `today`.

    A run is alive if it includes today, or ends yesterday (today is not over yet).
    """
    done = set(days)
    end = today if today in done else today - ONE_DAY
    if end not in done:
        return NO_STREAK
    start = end
    while start - ONE_DAY in done:
        start -= ONE_DAY
    return Streak((end - start).days + 1, start, end)


def longest_streak(days):
    """The longest run of consecutive days in `days` (the earliest one on a tie)."""
    best = NO_STREAK
    run_start = previous = None
    for day in sorted(set(days)):
        if previous is None or day - previous != ONE_DAY:
            run_start = day
        previous = day
        length = (day - run_start).days + 1
        if length > best.length:
            best = Streak(length, run_start, day)
    return best
