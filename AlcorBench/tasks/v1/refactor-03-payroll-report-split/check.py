"""Acceptance check: no function over 40 lines in payroll/, report output unchanged."""
import ast
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

TASK_DIR = str(Path(__file__).resolve().parent)
WORK = os.getcwd()
MAX_LINES = 40
MAX_WIDTH = 110


def clean_env(code_dir):
    """Minimal environment for running code from ``code_dir`` (nothing inherited but PATH)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": code_dir,
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}


def make_datasets():
    rng = random.Random(20261113)
    names = ["Ada Okafor", "Ben Li", "Cleo Marsh", "Dev Patel", "Eli Roth", "Fay Ng", "Gus Vale", "Hana Sato",
             "Ivo Kranz", "Jo Amari"]
    rates = ["18.50", "22", "35.75", "41.10", "60", "15.05", "125.40", "400", "27.333", "0", "abc", "-5"]
    hours_pool = ["8", "7.5", "9.25", "10", "12", "4", "0.25", "11.75", "24", "6.5"]
    bad_hours = ["0", "-2", "25", "24.01", "x", ""]
    datasets = []
    for n in range(36):
        emp_rows, ids = ["employee_id,name,hourly_rate,pension"], []
        for i in range(rng.randint(0, 7)):
            emp_id = f"E{rng.randint(1, 9)}"
            name = rng.choice(names) if rng.random() > 0.05 else ""
            rate = rng.choice(rates[:9]) if rng.random() > 0.12 else rng.choice(rates[9:])
            pension = rng.choice(["yes", "no", "Y", "true", "", "No"])
            pad = " " if rng.random() < 0.2 else ""
            emp_rows.append(f"{pad}{emp_id},{name},{rate}{pad},{pension}")
            ids.append(emp_id)
        start = date(2026, 1, 1) + timedelta(days=rng.randint(0, 360))
        sheet = ["employee_id,date,hours"]
        holidays = sorted({start + timedelta(days=rng.randint(0, 13)) for _ in range(rng.randint(0, 3))})
        for _ in range(rng.randint(0, 60)):
            emp_id = rng.choice(ids + ["E99"]) if ids else "E99"
            day = start + timedelta(days=rng.randint(0, 13))
            hours = rng.choice(hours_pool) if rng.random() > 0.08 else rng.choice(bad_hours)
            day_text = day.isoformat() if rng.random() > 0.04 else rng.choice(["2026-02-30", "yesterday", ""])
            sheet.append(f"{emp_id},{day_text},{hours}")
        hol = [h.isoformat() if k % 2 else h for k, h in enumerate(holidays)]
        datasets.append(("\n".join(sheet) + "\n", "\n".join(emp_rows) + "\n", f"Period {n}", hol))
    # Hand-picked edge cases.
    emps = "employee_id,name,hourly_rate,pension\nE1,Rich Person,400,yes\nE2,Part Timer,15.05,no\nE3,Nobody Home,20,yes\n"
    heavy = "employee_id,date,hours\n" + "".join(f"E1,2026-12-{d:02d},12\n" for d in range(21, 32))
    heavy += "E1,2027-01-01,9\nE2,2026-12-31,0.25\nE2,2027-01-04,24\n"
    datasets.append((heavy, emps, "Year end", ["2026-12-25", date(2027, 1, 1)]))
    datasets.append(("employee_id,date,hours\n", emps, "Empty timesheet", []))
    datasets.append(("employee_id,date,hours\nE1,2026-05-01,8\n", "employee_id,name,hourly_rate,pension\n", "No staff", []))
    datasets.append(("employee_id,date,hours\nE2,2026-06-01,8\n", emps + "E2,Dup Licate,99,yes\n,No Id,10,no\n", "Dups", ()))
    return datasets


PROBE = r'''
import json, os, sys
from datetime import date
sys.path.insert(0, os.getcwd())
from payroll.payslips import build_payslips
data = json.load(open(sys.argv[1], encoding="utf-8"))
out = []
for sheet, emps, label, hol in data:
    hol = [date.fromisoformat(h[2:]) if h.startswith("D:") else h for h in hol]
    try:
        out.append(build_payslips(sheet, emps, label, hol))
    except Exception as e:
        out.append(f"<raised {type(e).__name__}: {e}>")
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"))
'''


def render_all(code_dir, data_path, out_path):
    try:
        p = subprocess.run([sys.executable, "-c", PROBE, data_path, out_path], cwd=code_dir, env=clean_env(code_dir),
                           capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return None, "timed out"
    if p.returncode != 0:
        return None, (p.stdout + p.stderr).strip()[-500:]
    return json.load(open(out_path, encoding="utf-8")), ""


def run_cli(code_dir, args):
    try:
        p = subprocess.run([sys.executable, "-m", "payroll.cli", *args], cwd=code_dir, env=clean_env(code_dir),
                           capture_output=True, text=True, timeout=6)
        return p.returncode, p.stdout
    except subprocess.TimeoutExpired:
        return "timeout", ""


def long_functions():
    problems = []
    pkg = os.path.join(WORK, "payroll")
    for root, _, files in os.walk(pkg):
        for name in sorted(files):
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, WORK)
            try:
                tree = ast.parse(open(path, encoding="utf-8").read())
            except SyntaxError as e:
                problems.append(f"{rel} does not parse: {e}")
                continue
            for number, line in enumerate(open(path, encoding="utf-8").read().splitlines(), start=1):
                if len(line) > MAX_WIDTH:
                    problems.append(f"{rel} line {number} is {len(line)} characters long (limit {MAX_WIDTH})")
            starts = {}
            for node in ast.walk(tree):
                if isinstance(node, ast.stmt):
                    starts[node.lineno] = starts.get(node.lineno, 0) + 1
            crowded = sorted(n for n, count in starts.items() if count > 1)
            if crowded:
                problems.append(f"{rel} line {crowded[0]} holds more than one statement")
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    length = node.end_lineno - node.lineno + 1
                    if length > MAX_LINES:
                        problems.append(f"{rel}: {node.name}() is {length} lines long (limit {MAX_LINES})")
    return problems


def main():
    fails = long_functions()
    scratch = tempfile.mkdtemp(prefix="rf3-")
    try:
        orig = os.path.join(scratch, "orig")
        shutil.copytree(os.path.join(TASK_DIR, "fixture"), orig)
        datasets = make_datasets()
        encoded = [(s, e, l, [h if isinstance(h, str) else "D:" + h.isoformat() for h in hol])
                   for s, e, l, hol in datasets]
        data_path = os.path.join(scratch, "data.json")
        json.dump(encoded, open(data_path, "w", encoding="utf-8"))
        want, err = render_all(orig, data_path, os.path.join(scratch, "want.json"))
        if want is None:
            print("FAIL: internal: original code failed: " + err)
            return 1
        got, err = render_all(WORK, data_path, os.path.join(scratch, "got.json"))
        if got is None:
            fails.append("build_payslips could not be run: " + err)
        else:
            for i, (w, g) in enumerate(zip(want, got)):
                if w != g:
                    wl, gl = w.splitlines(), g.splitlines()
                    k = next((j for j, (a, b) in enumerate(zip(wl, gl)) if a != b), min(len(wl), len(gl)))
                    fails.append(f"report for dataset {i} ({datasets[i][2]}) differs at line {k + 1}: "
                                 f"expected {wl[k] if k < len(wl) else '<end>'!r}, got {gl[k] if k < len(gl) else '<end>'!r}")
                    break
        sheet, emps, label, hol = datasets[-4]
        with open(os.path.join(scratch, "ts.csv"), "w", encoding="utf-8") as fh:
            fh.write(sheet)
        with open(os.path.join(scratch, "em.csv"), "w", encoding="utf-8") as fh:
            fh.write(emps)
        args = [os.path.join(scratch, "ts.csv"), os.path.join(scratch, "em.csv"), "--period", label,
                "--holiday", "2026-12-25", "--holiday", "2027-01-01"]
        if run_cli(orig, args) != run_cli(WORK, args):
            fails.append("command-line output changed")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    try:
        t = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                           cwd=WORK, env=clean_env(WORK), capture_output=True, text=True, timeout=8)
        if t.returncode != 0:
            fails.append("tests in tests/ fail: " + t.stderr.strip()[-400:])
    except subprocess.TimeoutExpired:
        fails.append("tests timed out")

    for f in fails[:8]:
        print("FAIL:", f)
    if not fails:
        print("PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
