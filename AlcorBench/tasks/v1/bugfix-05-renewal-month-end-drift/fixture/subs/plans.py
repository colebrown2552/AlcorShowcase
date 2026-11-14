from dataclasses import dataclass


@dataclass(frozen=True)
class Plan:
    name: str
    interval_months: int
    price_cents: int


MONTHLY = Plan("monthly", 1, 1200)
QUARTERLY = Plan("quarterly", 3, 3300)
YEARLY = Plan("yearly", 12, 12000)

PLANS = {p.name: p for p in (MONTHLY, QUARTERLY, YEARLY)}
