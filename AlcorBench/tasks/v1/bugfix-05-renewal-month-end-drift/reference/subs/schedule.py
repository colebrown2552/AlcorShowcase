"""Renewal schedule for a subscription that started on ``start``."""
from subs.calendar_utils import add_months


def renewal_dates(start, plan, count):
    """The first ``count`` renewal dates after ``start``, in order."""
    if count < 0:
        raise ValueError("count must not be negative")
    # Always count from the start date, so a clamped short month does not
    # shift every later renewal.
    return [add_months(start, plan.interval_months * n) for n in range(1, count + 1)]


def next_renewal(start, plan, after):
    """The first renewal date strictly after the date ``after``."""
    n = 1
    current = add_months(start, plan.interval_months)
    while current <= after:
        n += 1
        current = add_months(start, plan.interval_months * n)
    return current
