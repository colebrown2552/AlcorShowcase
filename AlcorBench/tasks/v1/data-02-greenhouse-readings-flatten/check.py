import csv, json, os, subprocess, sys, tempfile

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


RECORDS = [
    {"ts": "2026-06-01T00:00:00Z", "device": "gh3-a", "zone": {"row": {"bay": {"id": 7}}, "name": 'east "wing", upper'},
     "flags": [True, None, 3, "x"], "meta": {}, "level": 0.0},
    {"device": "gh3-b", "ts": "2026-06-01T00:00:01Z", "Alarm": False, "level": -2, "zone": {"name": "Ünterhaus"}},
    {"device": "gh3-c", "ts": "2026-06-01T00:00:02Z", "zone": {"row": {"bay": {"id": None}}}, "flags": ["solo"]},
]
EXPECT_HEADER = ["device", "ts", "Alarm", "flags", "level", "zone.name", "zone.row.bay.id"]
EXPECT_ROWS = [
    ["gh3-a", "2026-06-01T00:00:00Z", "", "true||3|x", "0.0", 'east "wing", upper', "7"],
    ["gh3-b", "2026-06-01T00:00:01Z", "false", "", "-2", "Ünterhaus", ""],
    ["gh3-c", "2026-06-01T00:00:02Z", "", "solo", "", "", ""],
]


def convert(tmp, name, text):
    src = os.path.join(tmp, name + ".jsonl")
    dst = os.path.join(tmp, name + ".csv")
    with open(src, "w", encoding="utf-8") as fh:
        fh.write(text)
    p = run([sys.executable, "flatten_readings.py", src, dst])
    return p, dst


with tempfile.TemporaryDirectory() as tmp:
    text = json.dumps(RECORDS[0]) + "\n\n   \n" + json.dumps(RECORDS[1], ensure_ascii=False) + "\n" + json.dumps(RECORDS[2]) + "\n"
    p, dst = convert(tmp, "mixed", text)
    if p is None:
        fail("mixed file: timed out")
    elif p.returncode != 0 or not os.path.exists(dst):
        fail("mixed file: exit %s, %s" % (p.returncode, p.stderr.strip()[-200:]))
    else:
        with open(dst, encoding="utf-8", newline="") as fh:
            rows = list(csv.reader(fh))
        if not rows or rows[0] != EXPECT_HEADER:
            fail("mixed file: header %r, expected %r" % (rows[0] if rows else None, EXPECT_HEADER))
        elif rows[1:] != EXPECT_ROWS:
            fail("mixed file: rows %r, expected %r" % (rows[1:], EXPECT_ROWS))

    p, dst = convert(tmp, "empty", "\n")
    if p is None or p.returncode != 0 or not os.path.exists(dst):
        fail("file with no records: did not exit 0 and write output")
    else:
        with open(dst, encoding="utf-8", newline="") as fh:
            rows = [r for r in csv.reader(fh) if r]
        if rows != [["device", "ts"]]:
            fail("file with no records: expected only header device,ts, got %r" % rows)

    bad = json.dumps(RECORDS[1]) + "\n\n" + '{"device": "gh3-z", "ts": \n'
    p, dst = convert(tmp, "bad", bad)
    if p is None:
        fail("invalid JSON: timed out")
    elif p.returncode != 1 or "line 3: invalid JSON" not in p.stderr:
        fail("invalid JSON on line 3: expected exit 1 and 'line 3: invalid JSON' on stderr, got exit %s, stderr %r"
             % (p.returncode, p.stderr.strip()[-200:]))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
