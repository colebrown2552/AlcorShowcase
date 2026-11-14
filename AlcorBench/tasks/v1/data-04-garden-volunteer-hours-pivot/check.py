import csv, os, subprocess, sys, tempfile

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


LOG = """date,volunteer,plot,hours
2026-01-10,Zed Orme,pond,1.5
2025-12-13,al Brook,pond,2
2026-01-10,Zed Orme,beds,0.5
2026-02-14,Kit Lowe,beds,
2025-12-13,Zed Orme,pond,3.5
2026-01-24, al Brook ,beds,1
2026-03-01,Zed Orme,pond,
2026-01-31,Bea Corr,pond,2.5
"""

CASES = [
    ("all plots", LOG, [], [
        ["volunteer", "2025-12", "2026-01", "total"],
        ["Bea Corr", "0.0", "2.5", "2.5"],
        ["Zed Orme", "3.5", "2.0", "5.5"],
        ["al Brook", "2.0", "1.0", "3.0"],
        ["TOTAL", "5.5", "5.5", "11.0"],
    ]),
    ("--plot beds", LOG, ["--plot", "beds"], [
        ["volunteer", "2026-01", "total"],
        ["Zed Orme", "0.5", "0.5"],
        ["al Brook", "1.0", "1.0"],
        ["TOTAL", "1.5", "1.5"],
    ]),
    ("--plot with no shifts", LOG, ["--plot", "greenhouse"], [["volunteer", "total"], ["TOTAL", "0.0"]]),
    ("empty log", "date,volunteer,plot,hours\n", [], [["volunteer", "total"], ["TOTAL", "0.0"]]),
]

with tempfile.TemporaryDirectory() as tmp:
    for i, (name, text, extra, expect) in enumerate(CASES):
        src, dst = os.path.join(tmp, "log%d.csv" % i), os.path.join(tmp, "report%d.csv" % i)
        with open(src, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        p = run([sys.executable, "hours_report.py", src, dst] + extra)
        if p is None:
            fail("%s: timed out" % name)
            continue
        if p.returncode != 0 or not os.path.exists(dst):
            fail("%s: exit %s, no report: %s" % (name, p.returncode, p.stderr.strip()[-200:]))
            continue
        with open(dst, encoding="utf-8", newline="") as fh:
            rows = [[c.strip() for c in r] for r in csv.reader(fh) if r]
        if rows != expect:
            fail("%s: got %r, expected %r" % (name, rows, expect))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
