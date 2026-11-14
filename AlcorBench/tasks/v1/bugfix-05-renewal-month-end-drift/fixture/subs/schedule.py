"""Renewal schedule for a subscription that started on ``start``."""
from subs.calendar_utils import add_months


def renewal_dates(start, plan, count):
    """The first ``count`` renewal dates after ``start``, in order."""
    if count < 0:
        raise ValueError("count must not be negative")
    dates = []
    current = start
    for _ in range(count):
        current = add_months(current, plan.interval_months)
        dates.append(current)
    return dates


def next_renewal(start, plan, after):
    """The first renewal date strictly after the date ``after``."""
    current = add_months(start, plan.interval_months)
    while current <= after:
        current = add_months(current, plan.interval_months)
    return current
