"""Acceptance check: price strings convert to exact cents everywhere."""
import os
import subprocess
import sys


def clean_env(code_dir):
    """Minimal environment for running code from ``code_dir`` (nothing inherited but PATH)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": code_dir,
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}

PROBE = r'''
import os, sys
sys.path.insert(0, os.getcwd())
from billing.money import parse_amount
from billing.invoice import Invoice

fails = []

def expect_cents(text, want):
    try:
        got = parse_amount(text)
    except Exception as e:
        fails.append(f"parse_amount({text!r}) raised {type(e).__name__}: {e}")
        return False
    if got != want:
        fails.append(f"parse_amount({text!r}) = {got}, expected {want}")
        return False
    return True

# Every cent value for a spread of whole parts, in several notations.
done = False
for whole in (0, 1, 2, 4, 9, 10, 16, 33, 64, 99, 128, 255, 1000, 1019, 65535):
    for frac in range(100):
        want = whole * 100 + frac
        s = f"{whole}.{frac:02d}"
        if not expect_cents(s, want):
            done = True
            break
        if not expect_cents("-" + s, -want) or not expect_cents(f"({s})", -want):
            done = True
            break
        if not expect_cents(f"${whole:,}.{frac:02d}", want):
            done = True
            break
    if done:
        break

for text, want in (("7.5", 750), ("0.1", 10), ("12", 1200), ("$12,345,678.91", 1234567891),
                   ("  3.20 ", 320), ("(0.57)", -57), ("-0.01", -1), ("0.00", 0)):
    expect_cents(text, want)

for bad in ("", "abc", "12.3.4", "$", "1.2.3", "-", "()"):
    try:
        parse_amount(bad)
        fails.append(f"parse_amount({bad!r}) should raise ValueError")
    except ValueError:
        pass
    except Exception as e:
        fails.append(f"parse_amount({bad!r}) raised {type(e).__name__}, expected ValueError")

inv = Invoice("T-77", tax_basis_points=825)
inv.add_line("Cable ties", "4.35", 12)
inv.add_line("Washers", "0.29", 250)
inv.add_line("Gasket", "1.15", 7)
inv.add_line("Return credit", "(16.57)", 1)
sub = 435 * 12 + 29 * 250 + 115 * 7 - 1657
if inv.subtotal_cents() != sub:
    fails.append(f"invoice subtotal {inv.subtotal_cents()} != {sub}")
tax = (sub * 825 + 5000) // 10000
if inv.total_cents() != sub + tax:
    fails.append(f"invoice total {inv.total_cents()} != {sub + tax}")

for f in fails[:8]:
    print("FAIL:", f)
sys.exit(1 if fails else 0)
'''


def main():
    env = clean_env(os.getcwd())
    try:
        proc = subprocess.run([sys.executable, "-c", PROBE], cwd=os.getcwd(), env=env,
                              capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        print("FAIL: billing code did not finish within 20s")
        return 1
    if proc.returncode != 0:
        print((proc.stdout + proc.stderr).strip()[-1500:] or f"FAIL: probe exited {proc.returncode}")
        return 1
    try:
        tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                               cwd=os.getcwd(), env=env, capture_output=True, text=True, timeout=20)
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
