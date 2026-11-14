"""Acceptance check: renewals stay anchored to the start day."""
import os
import subprocess
import sys


def clean_env(code_dir):
    """Minimal environment for running code from ``code_dir`` (nothing inherited but PATH)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": code_dir,
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}

PROBE = r'''
import calendar, os, sys
from datetime import date, timedelta
sys.path.insert(0, os.getcwd())
from subs.schedule import next_renewal, renewal_dates
from subs.plans import Plan, MONTHLY, QUARTERLY, YEARLY
from subs.billing import upcoming_charges

fails = []

def anchored(start, months):
    idx = start.year * 12 + start.month - 1 + months
    y, m = divmod(idx, 12)
    m += 1
    return date(y, m, min(start.day, calendar.monthrange(y, m)[1]))

SEMI = Plan("semiannual", 6, 6000)
plans = (MONTHLY, QUARTERLY, SEMI, YEARLY)
starts = [date(2023, 1, 1) + timedelta(days=k) for k in range(0, 3 * 366, 3)]
starts += [date(2024, 2, 29), date(2025, 1, 31), date(2025, 8, 31), date(2025, 11, 30), date(2027, 12, 31)]

def first_bad():
    for start in starts:
        for plan in plans:
            want = [anchored(start, plan.interval_months * n) for n in range(1, 26)]
            got = renewal_dates(start, plan, 25)
            if list(got) != want:
                for g, w in zip(got, want):
                    if g != w:
                        return f"renewal_dates({start}, {plan.name}) gives {g} where {w} was expected"
                return f"renewal_dates({start}, {plan.name}, 25) returned {len(got)} dates"
    return None

try:
    msg = first_bad()
    if msg:
        fails.append(msg)
    if renewal_dates(date(2025, 1, 31), MONTHLY, 0) != []:
        fails.append("renewal_dates with count=0 should be empty")
    if upcoming_charges(date(2025, 10, 31), QUARTERLY, 3) != [("2026-01-31", 3300), ("2026-04-30", 3300), ("2026-07-31", 3300)]:
        fails.append(f"upcoming_charges for a 31 Oct quarterly plan: {upcoming_charges(date(2025, 10, 31), QUARTERLY, 3)}")
except Exception as e:
    fails.append(f"renewal_dates raised {type(e).__name__}: {e}")

def nr_oracle(start, plan, after):
    n = 1
    while anchored(start, plan.interval_months * n) <= after:
        n += 1
    return anchored(start, plan.interval_months * n)

cases = []
for start in (date(2025, 1, 31), date(2024, 2, 29), date(2023, 5, 30), date(2025, 3, 15), date(2022, 12, 31)):
    for plan in plans:
        for after in (start - timedelta(days=40), start, start + timedelta(days=1),
                      anchored(start, plan.interval_months * 3),
                      anchored(start, plan.interval_months * 3) - timedelta(days=1),
                      date(2031, 6, 30), date(2040, 2, 28)):
            cases.append((start, plan, after))
try:
    for start, plan, after in cases:
        got = next_renewal(start, plan, after)
        want = nr_oracle(start, plan, after)
        if got != want:
            fails.append(f"next_renewal({start}, {plan.name}, after={after}) = {got}, expected {want}")
            break
except Exception as e:
    fails.append(f"next_renewal raised {type(e).__name__}: {e}")

for f in fails:
    print("FAIL:", f)
sys.exit(1 if fails else 0)
'''


def main():
    env = clean_env(os.getcwd())
    try:
        proc = subprocess.run([sys.executable, "-c", PROBE], cwd=os.getcwd(), env=env,
                              capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        print("FAIL: schedule code did not finish within 30s")
        return 1
    if proc.returncode != 0:
        print((proc.stdout + proc.stderr).strip()[-1500:] or f"FAIL: probe exited {proc.returncode}")
        return 1
    try:
        tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                               cwd=os.getcwd(), env=env, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        print("FAIL: existing tests timed out")
        return 1
    if tests.returncode != 0:
        print("FAIL: existing tests in tests/ fail:\n" + tests.stderr[-800:])
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
