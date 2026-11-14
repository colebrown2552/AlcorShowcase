import csv, io, json, os, subprocess, sys, tempfile

FAILS = []

# Agent code runs with an explicit minimal environment: nothing inherited.
AGENT_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"}


def fail(msg):
    FAILS.append(msg)


def run(args, timeout=20):
    try:
        return subprocess.run(args, cwd=os.getcwd(), capture_output=True, text=True, env=AGENT_ENV, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


HEADER = "appt_id,clinician,patient_ref,appt_date,length,fee_gbp,notes\n"
COLS = ["visit_id", "visit_date", "patient_ref", "duration_min", "fee_pence"]

CASES = {
    "mixed": (
        HEADER
        + 'B-77,J. Amadi,pt-9001,7/11/2025,50,0.29,"ankle, left; ""urgent"""\n'
        + "B-78 ,J. Amadi,  Pt-9002,17/1/2026, 20 ,£ 1.10,\n"
        + "B-79,K. Lund,pt-9003,01/12/2025,90.0,£120,\"long, complex\"\n"
        + "B-80,K. Lund,pt-9004,31/12/2025,15,,\n"
        + "B-81,K. Lund,pt-9005,9/09/2026,40,8.70,\n",
        [
            ["B-77", "2025-11-07", "PT-9001", "50", "29"],
            ["B-78", "2026-01-17", "PT-9002", "20", "110"],
            ["B-79", "2025-12-01", "PT-9003", "90", "12000"],
            ["B-80", "2025-12-31", "PT-9004", "15", "0"],
            ["B-81", "2026-09-09", "PT-9005", "40", "870"],
        ],
    ),
    "empty": (HEADER, []),
}

with tempfile.TemporaryDirectory() as tmp:
    for name, (text, expected) in CASES.items():
        src = os.path.join(tmp, name + ".csv")
        dst = os.path.join(tmp, name + "-out.csv")
        with open(src, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        p = run([sys.executable, "export_for_billing.py", src, dst])
        if p is None:
            fail("%s export: timed out" % name)
            continue
        if p.returncode != 0 or not os.path.exists(dst):
            fail("%s export: exit %s, %s" % (name, p.returncode, p.stderr.strip()[-200:]))
            continue
        with open(dst, encoding="utf-8", newline="") as fh:
            rows = list(csv.reader(fh))
        if not rows or rows[0] != COLS:
            fail("%s export: header is %r" % (name, rows[0] if rows else None))
            continue
        body = rows[1:]
        if len(body) != len(expected):
            fail("%s export: expected %d data rows, got %d" % (name, len(expected), len(body)))
            continue
        for want, got in zip(expected, body):
            if [c.strip() for c in got] != want:
                fail("%s export: expected row %s, got %s" % (name, want, got))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
