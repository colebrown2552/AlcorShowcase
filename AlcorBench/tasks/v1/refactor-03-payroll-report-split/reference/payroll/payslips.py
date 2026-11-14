"""Payslip report for one pay period."""
import csv
import io
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from payroll.rates import (HOLIDAY_MULTIPLIER, OVERTIME_MULTIPLIER, OVERTIME_THRESHOLD_HOURS,
                           PENSION_CAP_CENTS, PENSION_RATE_BP, TAX_BRACKETS)

RULE = "-" * 44


def build_payslips(timesheet_csv, employees_csv, period_label, holidays=()):
    """Render the payslip report for one period.

    ``employees_csv`` has columns employee_id,name,hourly_rate,pension
    (pension is yes/no). ``timesheet_csv`` has columns employee_id,date,hours.
    ``holidays`` are dates (or ISO strings) paid at the holiday rate.
    Bad rows are skipped and listed as warnings at the end of the report.
    """
    warnings = []
    employees = load_employees(employees_csv, warnings)
    worked = load_timesheet(timesheet_csv, employees, warnings)
    holiday_set = {date.fromisoformat(h) if isinstance(h, str) else h for h in holidays}

    out = [f"PAYSLIPS - {period_label}", "=" * 44]
    totals = {"gross": 0, "tax": 0, "pension": 0, "net": 0}
    for emp_id in sorted(worked):
        emp = employees[emp_id]
        hours = split_hours(worked[emp_id], holiday_set)
        pay = compute_pay(emp, hours)
        for key in totals:
            totals[key] += pay[key]
        out += format_payslip(emp_id, emp, hours, pay)
    out += format_footer(employees, worked, totals, warnings)
    return "\n".join(out) + "\n"


def load_employees(employees_csv, warnings):
    """{employee_id: {"name", "rate", "pension"}}; bad rows become warnings."""
    employees = {}
    for lineno, row in enumerate(csv.DictReader(io.StringIO(employees_csv)), start=2):
        emp_id = (row.get("employee_id") or "").strip()
        name = (row.get("name") or "").strip()
        if not emp_id or not name:
            warnings.append(f"employees line {lineno}: missing id or name, skipped")
            continue
        try:
            rate = Decimal((row.get("hourly_rate") or "").strip())
        except InvalidOperation:
            rate = None
        if rate is None or rate <= 0:
            warnings.append(f"employees line {lineno}: bad hourly_rate {row.get('hourly_rate')!r}, skipped")
            continue
        if emp_id in employees:
            warnings.append(f"employees line {lineno}: duplicate id {emp_id}, first one kept")
            continue
        pension = (row.get("pension") or "").strip().lower() in ("yes", "y", "true", "1")
        employees[emp_id] = {"name": name, "rate": rate, "pension": pension}
    return employees


def load_timesheet(timesheet_csv, employees, warnings):
    """{employee_id: {(iso_year, iso_week): [(day, hours), ...]}}."""
    worked = {}
    for lineno, row in enumerate(csv.DictReader(io.StringIO(timesheet_csv)), start=2):
        entry = parse_timesheet_row(row, employees)
        if isinstance(entry, str):
            warnings.append(f"timesheet line {lineno}: {entry}, ignored")
            continue
        emp_id, day, hours = entry
        week = tuple(day.isocalendar())[:2]
        worked.setdefault(emp_id, {}).setdefault(week, []).append((day, hours))
    return worked


def parse_timesheet_row(row, employees):
    """(emp_id, day, hours), or a string saying what is wrong with the row."""
    emp_id = (row.get("employee_id") or "").strip()
    if emp_id not in employees:
        return f"unknown employee {emp_id!r}"
    try:
        day = date.fromisoformat((row.get("date") or "").strip())
    except ValueError:
        return f"bad date {row.get('date')!r}"
    try:
        hours = Decimal((row.get("hours") or "").strip())
    except InvalidOperation:
        return f"bad hours {row.get('hours')!r}"
    if hours <= 0 or hours > 24:
        return f"hours out of range ({hours})"
    return emp_id, day, hours


def split_hours(weeks, holiday_set):
    """Total (regular, overtime, holiday) hours; overtime is per ISO week."""
    regular = overtime = holiday = Decimal(0)
    for week in sorted(weeks):
        week_hours = Decimal(0)
        for day, hours in sorted(weeks[week]):
            if day in holiday_set:
                holiday += hours
                continue
            regular_part = max(Decimal(0), min(hours, OVERTIME_THRESHOLD_HOURS - week_hours))
            regular += regular_part
            overtime += hours - regular_part
            week_hours += hours
    return {"regular": regular, "overtime": overtime, "holiday": holiday}


def to_cents(amount):
    """Decimal currency units -> integer cents, rounding half up."""
    return int((amount * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def progressive_tax(gross):
    tax_bp = 0
    for lower, upper, rate_bp in TAX_BRACKETS:
        if gross <= lower:
            break
        top = gross if upper is None else min(gross, upper)
        tax_bp += (top - lower) * rate_bp
    return (tax_bp + 5_000) // 10_000


def compute_pay(emp, hours):
    rate = emp["rate"]
    pay = {
        "regular": to_cents(hours["regular"] * rate),
        "overtime": to_cents(hours["overtime"] * rate * OVERTIME_MULTIPLIER),
        "holiday": to_cents(hours["holiday"] * rate * HOLIDAY_MULTIPLIER),
    }
    gross = pay["regular"] + pay["overtime"] + pay["holiday"]
    tax = progressive_tax(gross)
    pension = 0
    if emp["pension"]:
        pension = min((gross * PENSION_RATE_BP + 5_000) // 10_000, PENSION_CAP_CENTS)
    pay.update(gross=gross, tax=tax, pension=pension, net=gross - tax - pension)
    return pay


def money(cents, width=15):
    return f"{cents / 100:>{width},.2f}"


def format_payslip(emp_id, emp, hours, pay):
    lines = ["", f"{emp['name']} ({emp_id}) @ {emp['rate']:.2f}/h"]
    for label in ("regular", "overtime", "holiday"):
        if label == "regular" or hours[label]:
            lines.append(f"  {label:<10}{hours[label]:>8.2f} h{money(pay[label])}")
    lines.append(f"  {'gross':<20}{money(pay['gross'])}")
    lines.append(f"  {'tax':<20}{money(-pay['tax'])}" if pay["tax"] else f"  {'tax':<20}{'0.00':>15}")
    if emp["pension"]:
        lines.append(f"  {'pension':<20}{money(-pay['pension'])}")
    lines.append(f"  {'net pay':<20}{money(pay['net'])}")
    return lines


def format_footer(employees, worked, totals, warnings):
    lines = []
    idle = sorted(employees[e]["name"] for e in employees if e not in worked)
    if idle:
        lines += ["", "No hours recorded: " + ", ".join(idle)]
    lines += ["", RULE, f"{len(worked)} payslip(s)"]
    for key in ("gross", "tax", "pension", "net"):
        lines.append(f"total {key:<14}{money(totals[key])}")
    if warnings:
        lines += ["", f"{len(warnings)} warning(s):"]
        lines += [f"  - {warning}" for warning in warnings]
    return lines
