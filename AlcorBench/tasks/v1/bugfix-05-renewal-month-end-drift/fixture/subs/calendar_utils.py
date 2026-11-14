"""Month arithmetic that clamps to the end of short months."""
import calendar
from datetime import date


def days_in_month(year, month):
    return calendar.monthrange(year, month)[1]


def add_months(day, months):
    """Return ``day`` moved by ``months`` calendar months.

    If the target month is too short the result is clamped to its last day:
    add_months(date(2025, 1, 31), 1) == date(2025, 2, 28).
    """
    index = day.year * 12 + (day.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(day.day, days_in_month(year, month)))
