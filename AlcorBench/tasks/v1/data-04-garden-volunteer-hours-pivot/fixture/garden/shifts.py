"""Read the shift log kept at the Quarry Road community garden."""
import csv
from collections import namedtuple
from datetime import date

Shift = namedtuple("Shift", "day volunteer plot hours")


def load_shifts(path):
    """Return a list of Shift from the shift log CSV.

    Columns: date (YYYY-MM-DD), volunteer, plot, hours.
    `volunteer` and `plot` are trimmed. `hours` is a float, or None when the
    cell was left blank (the shift was planned but not worked).
    """
    shifts = []
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            text = (row.get("hours") or "").strip()
            shifts.append(Shift(
                day=date.fromisoformat(row["date"].strip()),
                volunteer=row["volunteer"].strip(),
                plot=row["plot"].strip(),
                hours=float(text) if text else None,
            ))
    return shifts
