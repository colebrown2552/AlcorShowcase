import os, subprocess, sys, tempfile

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


LOG = """2026-07-01T23:52:10Z GET /pkgs/fenn-0.3.tar.gz 200 1000 0.120

2026-07-02T00:31:59Z GET /pkgs/index.json 404 120 0.010
2026-07-01T23:44:59Z GET /pkgs/index.json 304 - 0.003
2026-07-02T00:00:00Z GET /pkgs/fenn-0.4.tar.gz 502 88 1.001
2026-07-01T23:45:00Z GET /pkgs/fenn-0.4.tar.gz 200 2048 0.0996
2026-07-02T00:14:59Z GET /pkgs/fenn-0.4.tar.gz 500 0 2.5
2026/07/02 00:20:00 GET /pkgs/x 200 1 0.1
2026-07-02T00:20:00Z GET /pkgs/x 200 1
2026-07-02T00:20:00Z GET /pkgs/x OK 1 0.1
   
"""
HEAD = "bucket_start,requests,errors,bytes,max_ms"
EXPECT = {
    "15m": """2026-07-01T23:30:00Z,1,0,0,3
2026-07-01T23:45:00Z,2,0,3048,120
2026-07-02T00:00:00Z,2,2,88,2500
2026-07-02T00:15:00Z,0,0,0,0
2026-07-02T00:30:00Z,1,0,120,10""",
    "1h": """2026-07-01T23:00:00Z,3,0,3048,120
2026-07-02T00:00:00Z,3,2,208,2500""",
    "7m": """2026-07-01T23:39:00Z,2,0,2048,100
2026-07-01T23:46:00Z,1,0,1000,120
2026-07-01T23:53:00Z,0,0,0,0
2026-07-02T00:00:00Z,1,1,88,1001
2026-07-02T00:07:00Z,0,0,0,0
2026-07-02T00:14:00Z,1,1,0,2500
2026-07-02T00:21:00Z,0,0,0,0
2026-07-02T00:28:00Z,1,0,120,10""",
    None: """2026-07-01T23:40:00Z,1,0,0,3
2026-07-01T23:45:00Z,1,0,2048,100
2026-07-01T23:50:00Z,1,0,1000,120
2026-07-01T23:55:00Z,0,0,0,0
2026-07-02T00:00:00Z,1,1,88,1001
2026-07-02T00:05:00Z,0,0,0,0
2026-07-02T00:10:00Z,1,1,0,2500
2026-07-02T00:15:00Z,0,0,0,0
2026-07-02T00:20:00Z,0,0,0,0
2026-07-02T00:25:00Z,0,0,0,0
2026-07-02T00:30:00Z,1,0,120,10""",
}


def lines(text):
    return [l.strip() for l in text.strip().splitlines() if l.strip()]


with tempfile.TemporaryDirectory() as tmp:
    log = os.path.join(tmp, "access.log")
    with open(log, "w", encoding="utf-8") as fh:
        fh.write(LOG)
    for size, body in EXPECT.items():
        label = "--bucket %s" % size if size else "default bucket"
        p = run([sys.executable, "bucket_report.py", log] + (["--bucket", size] if size else []))
        if p is None:
            fail("%s: timed out" % label)
            continue
        if p.returncode != 0:
            fail("%s: exit %s: %s" % (label, p.returncode, p.stderr.strip()[-200:]))
            continue
        want = [HEAD] + lines(body)
        got = lines(p.stdout)
        if got != want:
            fail("%s: got %r, expected %r" % (label, got, want))
        if "skipped 3 malformed lines" not in p.stderr:
            fail("%s: expected 'skipped 3 malformed lines' on stderr, got %r" % (label, p.stderr.strip()[-200:]))

    empty = os.path.join(tmp, "empty.log")
    open(empty, "w").close()
    p = run([sys.executable, "bucket_report.py", empty, "--bucket", "1h"])
    if p is None or p.returncode != 0 or lines(p.stdout) != [HEAD]:
        fail("empty log: expected only the header and exit 0")

    for bad in ["0m", "90s", "1.5h", "h", "15"]:
        p = run([sys.executable, "bucket_report.py", log, "--bucket", bad])
        if p is None or p.returncode != 2 or "invalid bucket size" not in p.stderr:
            fail("--bucket %s: expected exit 2 and 'invalid bucket size' on stderr" % bad)

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
