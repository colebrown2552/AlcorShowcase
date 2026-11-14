"""python3 -m payroll.cli TIMESHEET.csv EMPLOYEES.csv --period LABEL [--holiday YYYY-MM-DD ...]"""
import argparse
import sys

from payroll.payslips import build_payslips


def main(argv=None):
    parser = argparse.ArgumentParser(prog="payroll")
    parser.add_argument("timesheet")
    parser.add_argument("employees")
    parser.add_argument("--period", required=True)
    parser.add_argument("--holiday", action="append", default=[])
    args = parser.parse_args(argv)
    with open(args.timesheet, encoding="utf-8") as fh:
        timesheet = fh.read()
    with open(args.employees, encoding="utf-8") as fh:
        employees = fh.read()
    sys.stdout.write(build_payslips(timesheet, employees, args.period, args.holiday))
    return 0


if __name__ == "__main__":
    sys.exit(main())
