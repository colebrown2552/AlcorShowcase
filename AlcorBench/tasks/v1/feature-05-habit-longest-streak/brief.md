The habit tracker shows your *current* streak, and people keep asking for their personal best. Please add `longest_streak` to `habits/streaks.py` and export it from the `habits` package, next to `current_streak`.

**Signature:** `longest_streak(days) -> Streak`

- `days` is any iterable of `datetime.date` (a set from `parse_journal`, a list, a generator), in any order, possibly with the same date more than once. Repeated dates count once.
- A streak is a run of consecutive calendar days. Month and year boundaries are just days like any other (Feb 28 -> Feb 29 -> Mar 1 in a leap year, Dec 31 -> Jan 1).
- Return the longest run as `Streak(length, start, end)`, where `start` and `end` are its first and last day, the same shape `current_streak` returns.
- If several runs share the maximum length, return the earliest one.
- With no dates at all, return `Streak(0)` (i.e. `length` 0, `start` and `end` `None`), like `current_streak` does when there is no streak.
- It must not depend on today's date.

Example: done on Mar 1, 2, 3, 7, 8 -> `Streak(3, date(2026, 3, 1), date(2026, 3, 3))`.

Leave `current_streak` and the journal parser as they are. `tests/test_streaks.py` must keep passing; don't change it.
