"""Acceptance check: exports are standard CSV and import(export(x)) == x."""
import os
import subprocess
import sys


def clean_env(code_dir):
    """Minimal environment for running code from ``code_dir`` (nothing inherited but PATH)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": code_dir,
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}

PROBE = r'''
import csv, os, sys, tempfile
sys.path.insert(0, os.getcwd())
from addressbook.exporter import export_contacts
from addressbook.importer import import_contacts
from addressbook.models import Contact, FIELD_NAMES

fails = []
tricky = [
    Contact("Hartley, Webb & Sons Ltd", "ops@hartley.example", "Hartley, Webb & Sons", "+44 20 7946 0000", "invoice, then call"),
    Contact('Ines "Nessie" Duarte', "ines@example.pt", '"Acme" Holdings', "", 'said "maybe" twice'),
    Contact("Kofi Mensah", "", "", "", "line one\nline two\n\nline four"),
    Contact("Zoë Ångström-Łukasz", "zoe@example.se", "Café Ñandú", "555-0199", "ünïcödé, ok"),
    Contact("Plain Person", "plain@example.com", "Plain Co", "555-0123", ""),
    Contact("Trailing comma,", "", ",,,", ",", "\"\""),
    Contact("Only Name"),
]

with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "export.csv")
    try:
        n = export_contacts(tricky, path)
        if n != len(tricky):
            fails.append(f"export_contacts returned {n}, expected {len(tricky)}")
        with open(path, encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            parsed = list(reader)
            header = reader.fieldnames
        if header != FIELD_NAMES:
            fails.append(f"export header is {header}, expected {FIELD_NAMES}")
        elif len(parsed) != len(tricky):
            fails.append(f"a standard CSV reader sees {len(parsed)} records in the export of {len(tricky)} contacts")
        else:
            for row, c in zip(parsed, tricky):
                want = {k: getattr(c, k) for k in FIELD_NAMES}
                if dict(row) != want:
                    fails.append(f"a standard CSV reader parses the record for {c.name!r} as {dict(row)}")
                    break
    except Exception as e:
        fails.append(f"export failed: {type(e).__name__}: {e}")
    try:
        back = import_contacts(path)
        if back != tricky:
            bad = next((i for i, (a, b) in enumerate(zip(back, tricky)) if a != b), min(len(back), len(tricky)))
            fails.append(f"round trip changed contacts (count {len(back)} vs {len(tricky)}; first difference at #{bad}: "
                         f"{back[bad] if bad < len(back) else None!r})")
    except Exception as e:
        fails.append(f"import of own export failed: {type(e).__name__}: {e}")

    # A standard CSV produced elsewhere: quoted everything, reordered, extra column, blank lines.
    other = os.path.join(d, "crm.csv")
    with open(other, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, quoting=csv.QUOTE_ALL)
        w.writerow(["company", "name", "source", "notes"])
        w.writerow(["Hartley, Webb & Sons", 'Mo "Ace" Lee', "crm", "two\nlines"])
        fh.write("\r\n")
        w.writerow(["", "Bo Diaz", "crm", ""])
    try:
        got = import_contacts(other)
        want = [Contact('Mo "Ace" Lee', "", "Hartley, Webb & Sons", "", "two\nlines"), Contact("Bo Diaz")]
        if got != want:
            fails.append(f"importing a quoted CSV from another tool gave {got!r}")
    except Exception as e:
        fails.append(f"importing a quoted CSV from another tool failed: {type(e).__name__}: {e}")

    # Edge: empty contact list exports a header only and imports as empty.
    empty = os.path.join(d, "none.csv")
    try:
        export_contacts([], empty)
        if import_contacts(empty) != []:
            fails.append("export of no contacts does not import as an empty list")
    except Exception as e:
        fails.append(f"empty export/import failed: {type(e).__name__}: {e}")

for f in fails:
    print("FAIL:", f)
sys.exit(1 if fails else 0)
'''


def main():
    env = clean_env(os.getcwd())
    try:
        proc = subprocess.run([sys.executable, "-c", PROBE], cwd=os.getcwd(), env=env,
                              capture_output=True, text=True, timeout=20, encoding="utf-8")
    except subprocess.TimeoutExpired:
        print("FAIL: address book code did not finish within 20s")
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
