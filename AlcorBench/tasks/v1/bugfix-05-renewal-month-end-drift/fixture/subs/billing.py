"""Upcoming charges for the customer portal."""
from subs.schedule import renewal_dates


def upcoming_charges(start, plan, count=3):
    """[(iso_date, price_cents), ...] for the next ``count`` renewals."""
    return [(d.isoformat(), plan.price_cents) for d in renewal_dates(start, plan, count)]


def annual_cost_cents(plan):
    return plan.price_cents * (12 // plan.interval_months)
