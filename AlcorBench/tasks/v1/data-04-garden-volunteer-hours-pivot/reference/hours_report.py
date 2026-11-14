"""Monthly volunteer-hours report for the garden committee."""
import argparse
import csv
import sys
from collections import defaultdict

from garden.shifts import load_shifts


def build_report(shifts, plot=None):
    """Return the report as a list of rows (header first)."""
    totals = defaultdict(lambda: defaultdict(float))
    months = set()
    for shift in shifts:
        if shift.hours is None or (plot is not None and shift.plot != plot):
            continue
        month = shift.day.strftime("%Y-%m")
        months.add(month)
        totals[shift.volunteer][month] += shift.hours
    months = sorted(months)
    rows = [["volunteer"] + months + ["total"]]
    column_sums = defaultdict(float)
    for volunteer in sorted(totals):
        cells = [totals[volunteer][m] for m in months]
        for m, value in zip(months, cells):
            column_sums[m] += value
        rows.append([volunteer] + ["%.1f" % v for v in cells] + ["%.1f" % sum(cells)])
    sums = [column_sums[m] for m in months]
    rows.append(["TOTAL"] + ["%.1f" % v for v in sums] + ["%.1f" % sum(sums)])
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shifts_csv")
    parser.add_argument("report_csv")
    parser.add_argument("--plot", help="only count shifts on this plot")
    args = parser.parse_args(argv)
    shifts = load_shifts(args.shifts_csv)
    with open(args.report_csv, "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(build_report(shifts, args.plot))
    return 0


if __name__ == "__main__":
    sys.exit(main())
