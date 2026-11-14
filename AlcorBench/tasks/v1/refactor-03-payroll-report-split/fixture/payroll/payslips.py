"""Payslip report for one pay period."""
import csv
import io
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from payroll.rates import (HOLIDAY_MULTIPLIER, OVERTIME_MULTIPLIER, OVERTIME_THRESHOLD_HOURS,
                           PENSION_CAP_CENTS, PENSION_RATE_BP, TAX_BRACKETS)


def build_payslips(timesheet_csv, employees_csv, period_label, holidays=()):
    """Render the payslip report for one period.

    ``employees_csv`` has columns employee_id,name,hourly_rate,pension
    (pension is yes/no). ``timesheet_csv`` has columns employee_id,date,hours.
    ``holidays`` are dates (or ISO strings) paid at the holiday rate.
    Bad rows are skipped and listed as warnings at the end of the report.
    """
    warnings = []

    # Employees.
    employees = {}
    reader = csv.DictReader(io.StringIO(employees_csv))
    for lineno, row in enumerate(reader, start=2):
        emp_id = (row.get("employee_id") or "").strip()
        name = (row.get("name") or "").strip()
        if not emp_id or not name:
            warnings.append(f"employees line {lineno}: missing id or name, skipped")
            continue
        try:
            rate = Decimal((row.get("hourly_rate") or "").strip())
        except InvalidOperation:
            warnings.append(f"employees line {lineno}: bad hourly_rate {row.get('hourly_rate')!r}, skipped")
            continue
        if rate <= 0:
            warnings.append(f"employees line {lineno}: bad hourly_rate {row.get('hourly_rate')!r}, skipped")
            continue
        if emp_id in employees:
            warnings.append(f"employees line {lineno}: duplicate id {emp_id}, first one kept")
            continue
        pension = (row.get("pension") or "").strip().lower() in ("yes", "y", "true", "1")
        employees[emp_id] = {"name": name, "rate": rate, "pension": pension}

    # Timesheet, grouped by employee and ISO week.
    holiday_set = set()
    for h in holidays:
        holiday_set.add(date.fromisoformat(h) if isinstance(h, str) else h)
    worked = {}
    reader = csv.DictReader(io.StringIO(timesheet_csv))
    for lineno, row in enumerate(reader, start=2):
        emp_id = (row.get("employee_id") or "").strip()
        if emp_id not in employees:
            warnings.append(f"timesheet line {lineno}: unknown employee {emp_id!r}, ignored")
            continue
        try:
            day = date.fromisoformat((row.get("date") or "").strip())
        except ValueError:
            warnings.append(f"timesheet line {lineno}: bad date {row.get('date')!r}, ignored")
            continue
        try:
            hours = Decimal((row.get("hours") or "").strip())
        except InvalidOperation:
            warnings.append(f"timesheet line {lineno}: bad hours {row.get('hours')!r}, ignored")
            continue
        if hours <= 0 or hours > 24:
            warnings.append(f"timesheet line {lineno}: hours out of range ({hours}), ignored")
            continue
        week = tuple(day.isocalendar())[:2]
        worked.setdefault(emp_id, {}).setdefault(week, []).append((day, hours))

    # Pay per employee.
    out = [f"PAYSLIPS - {period_label}", "=" * 44]
    totals = {"gross": 0, "tax": 0, "pension": 0, "net": 0}
    for emp_id in sorted(worked):
        emp = employees[emp_id]
        regular = overtime = holiday = Decimal(0)
        for week in sorted(worked[emp_id]):
            week_hours = Decimal(0)
            for day, hours in sorted(worked[emp_id][week]):
                if day in holiday_set:
                    holiday += hours
                    continue
                if week_hours >= OVERTIME_THRESHOLD_HOURS:
                    overtime += hours
                elif week_hours + hours > OVERTIME_THRESHOLD_HOURS:
                    regular_part = OVERTIME_THRESHOLD_HOURS - week_hours
                    regular += regular_part
                    overtime += hours - regular_part
                else:
                    regular += hours
                week_hours += hours

        cents = Decimal(100)
        regular_pay = int((regular * emp["rate"] * cents).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        overtime_pay = int((overtime * emp["rate"] * OVERTIME_MULTIPLIER * cents)
                           .quantize(Decimal(1), rounding=ROUND_HALF_UP))
        holiday_pay = int((holiday * emp["rate"] * HOLIDAY_MULTIPLIER * cents)
                          .quantize(Decimal(1), rounding=ROUND_HALF_UP))
        gross = regular_pay + overtime_pay + holiday_pay

        tax_bp = 0
        for lower, upper, rate_bp in TAX_BRACKETS:
            if gross <= lower:
                break
            top = gross if upper is None else min(gross, upper)
            tax_bp += (top - lower) * rate_bp
        tax = (tax_bp + 5_000) // 10_000

        pension = 0
        if emp["pension"]:
            pension = min((gross * PENSION_RATE_BP + 5_000) // 10_000, PENSION_CAP_CENTS)
        net = gross - tax - pension

        totals["gross"] += gross
        totals["tax"] += tax
        totals["pension"] += pension
        totals["net"] += net

        out.append("")
        out.append(f"{emp['name']} ({emp_id}) @ {emp['rate']:.2f}/h")
        rows = [("regular", regular, regular_pay)]
        if overtime:
            rows.append(("overtime", overtime, overtime_pay))
        if holiday:
            rows.append(("holiday", holiday, holiday_pay))
        for label, hours, pay in rows:
            out.append(f"  {label:<10}{hours:>8.2f} h{pay / 100:>15,.2f}")
        out.append(f"  {'gross':<20}{gross / 100:>15,.2f}")
        out.append(f"  {'tax':<20}{-tax / 100:>15,.2f}" if tax else f"  {'tax':<20}{'0.00':>15}")
        if emp["pension"]:
            out.append(f"  {'pension':<20}{-pension / 100:>15,.2f}")
        out.append(f"  {'net pay':<20}{net / 100:>15,.2f}")

    idle = sorted(employees[e]["name"] for e in employees if e not in worked)
    if idle:
        out.append("")
        out.append("No hours recorded: " + ", ".join(idle))

    out.append("")
    out.append("-" * 44)
    out.append(f"{len(worked)} payslip(s)")
    for key in ("gross", "tax", "pension", "net"):
        amount = totals[key]
        out.append(f"total {key:<14}{amount / 100:>15,.2f}")

    if warnings:
        out.append("")
        out.append(f"{len(warnings)} warning(s):")
        for warning in warnings:
            out.append(f"  - {warning}")
    return "\n".join(out) + "\n"
