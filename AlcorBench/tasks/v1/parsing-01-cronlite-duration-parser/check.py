import json, os, subprocess, sys

FAILS = []

# Agent code runs with an explicit minimal environment: nothing inherited.
AGENT_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"}


def fail(msg):
    FAILS.append(msg)


DRIVER = r'''
import json, sys
from cronlite.durations import parse_duration
out = []
for text in json.loads(sys.stdin.read()):
    try:
        value = parse_duration(text)
        out.append({"ok": value, "type": type(value).__name__})
    except ValueError as exc:
        out.append({"error": str(exc)})
    except Exception as exc:
        out.append({"other": type(exc).__name__})
print("@@RESULT@@" + json.dumps(out))
'''

GOOD = {
    "15m 30s": 930, " 2h ": 7200, "1d1h1m1s": 90061, "3d 4s": 259204, "0": 0, "  7  ": 7,
    "120m": 7200, "1h0m": 3600, "0d0h0m0s": 0, "2h\t5m": 7500, "36h": 129600, "1h 1s": 3601, "100s": 100,
}
BAD = ["", "   ", "1h30", "30m1h", "1h1h", "h", "1.5h", "-5m", "+5m", "1 h", "5mm", "1H", "1h30m10", "m30", "1w", "1h,30m", "s1"]

p = None
try:
    p = subprocess.run([sys.executable, "-c", DRIVER], cwd=os.getcwd(), input=json.dumps(list(GOOD) + BAD),
                       capture_output=True, text=True, env=AGENT_ENV, timeout=20)
except subprocess.TimeoutExpired:
    fail("parse_duration timed out")
results = None
if p is not None:
    for line in reversed(p.stdout.splitlines()):
        if line.startswith("@@RESULT@@"):
            results = json.loads(line[10:])
            break
    if results is None:
        fail("could not call parse_duration: %s" % p.stderr.strip()[-200:])
if results is not None:
    for (text, want), got in zip(GOOD.items(), results):
        if got != {"ok": want, "type": "int"}:
            fail("parse_duration(%r): expected int %d, got %s" % (text, want, json.dumps(got)))
    for text, got in zip(BAD, results[len(GOOD):]):
        want = {"error": "invalid duration: %r" % (text,)}
        if got != want:
            fail("parse_duration(%r): expected ValueError %r, got %s" % (text, want["error"], json.dumps(got)))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
