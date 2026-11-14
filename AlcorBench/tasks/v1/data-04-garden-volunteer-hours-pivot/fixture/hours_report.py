"""Monthly volunteer-hours report for the garden committee."""
import argparse
import sys

from garden.shifts import load_shifts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shifts_csv")
    parser.add_argument("report_csv")
    args = parser.parse_args(argv)
    shifts = load_shifts(args.shifts_csv)
    # TODO: build the report
    return 0


if __name__ == "__main__":
    sys.exit(main())
