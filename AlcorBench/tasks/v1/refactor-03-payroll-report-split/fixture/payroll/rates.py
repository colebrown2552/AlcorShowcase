"""Pay rules. Money is in integer cents; rates in basis points (1/100 %)."""
from decimal import Decimal

OVERTIME_THRESHOLD_HOURS = Decimal(40)      # per ISO week, holidays excluded
OVERTIME_MULTIPLIER = Decimal("1.5")
HOLIDAY_MULTIPLIER = Decimal(2)

# (lower bound, upper bound or None, rate in basis points) on gross pay per period
TAX_BRACKETS = (
    (0, 1_000_00, 0),
    (1_000_00, 4_000_00, 1_500),
    (4_000_00, 9_000_00, 2_800),
    (9_000_00, None, 4_000),
)

PENSION_RATE_BP = 500
PENSION_CAP_CENTS = 400_00
