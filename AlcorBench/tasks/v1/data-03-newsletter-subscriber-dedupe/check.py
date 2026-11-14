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


INPUT = """email,name,signed_up,source
Rowan.Pike@Example.org ,Rowan P (new),2026-04-02 11:00:00,fair
dee.ash@example.com,Dee,2025-09-01 08:00:00,web
,Nobody,2026-01-01 00:00:00,web
rowan.pike@example.org,Rowan (old),2026-01-15 09:00:00,web
dee.ash+news@example.com,Dee (alias),2025-09-02 08:00:00,web
DEE.ASH@EXAMPLE.COM,Dee Ash,2025-09-01 08:00:00,"import, batch 2"
  ,Blank Too,2026-02-01 00:00:00,web
ROWAN.PIKE@example.org,Rowan Pike,2026-04-02 10:59:59,web
oak@example.net,Oak,2024-12-31 23:59:59,web
"""
EXPECT = [
    ["email", "name", "signed_up", "source"],
    ["rowan.pike@example.org", "Rowan P (new)", "2026-04-02 11:00:00", "fair"],
    ["dee.ash@example.com", "Dee Ash", "2025-09-01 08:00:00", "import, batch 2"],
    ["dee.ash+news@example.com", "Dee (alias)", "2025-09-02 08:00:00", "web"],
    ["oak@example.net", "Oak", "2024-12-31 23:59:59", "web"],
]

with tempfile.TemporaryDirectory() as tmp:
    for name, text, expect in [("mixed", INPUT, EXPECT), ("empty", "email,name,signed_up,source\n", EXPECT[:1])]:
        src, dst = os.path.join(tmp, name + ".csv"), os.path.join(tmp, name + "-out.csv")
        with open(src, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        p = run([sys.executable, "clean_list.py", src, dst])
        if p is None:
            fail("%s list: timed out" % name)
            continue
        if p.returncode != 0 or not os.path.exists(dst):
            fail("%s list: exit %s, %s" % (name, p.returncode, p.stderr.strip()[-200:]))
            continue
        with open(dst, encoding="utf-8", newline="") as fh:
            rows = [r for r in csv.reader(fh) if r]
        if rows[:1] != expect[:1]:
            fail("%s list: header %r" % (name, rows[:1]))
        elif rows != expect:
            fail("%s list: got rows %r, expected %r" % (name, rows[1:], expect[1:]))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
