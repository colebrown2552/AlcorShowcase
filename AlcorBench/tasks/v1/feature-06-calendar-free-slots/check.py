#!/usr/bin/env python3
"""Acceptance check. Run with the work directory as cwd."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

WORK = os.getcwd()
# This check's own folder. Nothing under it is ever passed to the code under test.
TASK_DIR = Path(__file__).resolve().parent
# Code under test runs with this explicit minimal environment, never the inherited one.
CHILD_ENV = {
    "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUTF8": "1",
}
MARK = "@@RESULT@@"
FAILS = []

_PRELUDE = '''
import json, sys
sys.path.insert(0, %r)
_R = {}
def case(name, fn):
    try:
        _R[name] = ["ok", fn()]
    except Exception as e:
        _R[name] = ["err", type(e).__name__, str(e)[:160]]
'''


def probe(body, timeout=20):
    """Run python code against the work dir in a subprocess; return dict of case results."""
    code = _PRELUDE % WORK + body + "\nprint(%r + json.dumps(_R, default=repr))\n" % MARK
    try:
        p = subprocess.run([sys.executable, "-B", "-c", code], cwd=WORK, env=CHILD_ENV, capture_output=True,
                           text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "code under test timed out"
    for line in reversed(p.stdout.splitlines()):
        if line.startswith(MARK):
            return json.loads(line[len(MARK):]), None
    tail = (p.stderr.strip().splitlines() or ["no output, exit %s" % p.returncode])[-1]
    return None, "could not run code under test: " + tail[:200]


def run_cmd(args, stdin=None, cwd=None, timeout=20):
    """Run a command; return (code, stdout, stderr) or None on timeout."""
    try:
        p = subprocess.run(args, cwd=cwd or WORK, env=CHILD_ENV, input=stdin, capture_output=True, text=True,
                           timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    return p.returncode, p.stdout, p.stderr


def expect(res, name, want):
    got = res.get(name)
    if want and want[0] == "err":
        ok = bool(got) and got[0] == "err" and got[1] == want[1]
    else:
        ok = got == want
    if not ok:
        FAILS.append("%s: expected %r, got %r" % (name, want, got))


def fail(msg):
    FAILS.append(msg)


def finish():
    if FAILS:
        for line in FAILS[:8]:
            print("FAIL " + line)
        if len(FAILS) > 8:
            print("... and %d more" % (len(FAILS) - 8))
        sys.exit(1)
    print("ok")
    sys.exit(0)


def need(res, err):
    if res is None:
        print("FAIL " + err)
        sys.exit(1)
    return res


def run_visible_tests():
    """The project's own tests (protected from edits) must still pass."""
    if not os.path.isdir(os.path.join(WORK, "tests")):
        return
    r = run_cmd([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"], timeout=40)
    if r is None:
        fail("existing tests timed out")
    elif r[0] != 0:
        fail("existing tests fail: " + (r[2].strip().splitlines() or ["?"])[-1][:150])

# ---- task-specific checks ----
res = need(*probe(r'''
from roomcal import Booking, free_slots
B = Booking
day = [B("Maple", "11:00", "12:15"), B("Cedar", "07:00", "20:00"), B("Maple", "07:30", "08:45"),
       B("Maple", "12:00", "12:30"), B("Maple", "12:30", "13:00"), B("Maple", "16:40", "19:00"),
       B("Maple", "11:15", "11:45"), B("Maple", "06:00", "07:00"), B("Maple", "21:00", "22:00")]
L = lambda r: [list(p) for p in r]
case("main", lambda: L(free_slots(day, "Maple")))
case("min136", lambda: L(free_slots(day, "Maple", min_minutes=136)))
case("min_exact", lambda: L(free_slots(day, "Maple", min_minutes=135)))
small = [B("Birch", "09:30", "09:35"), B("Birch", "09:00", "09:10"), B("Birch", "10:00", "10:05"),
         B("Birch", "09:20", "09:30")]
case("small0", lambda: L(free_slots(small, "Birch", "09:00", "10:10")))
case("small10", lambda: L(free_slots(small, "Birch", "09:00", "10:10", 10)))
case("small11", lambda: L(free_slots(small, "Birch", "09:00", "10:10", 11)))
case("window", lambda: L(free_slots(day, "Maple", day_start="12:00", day_end="17:00")))
case("full", lambda: L(free_slots(day, "Cedar")))
case("empty_room", lambda: L(free_slots(day, "Birch", "09:05", "09:50")))
case("midnight", lambda: L(free_slots([B("Birch", "23:00", "24:00")], "Birch", "00:00", "24:00")))
case("tuple_type", lambda: [type(p).__name__ for p in free_slots(day, "Maple", min_minutes=100)])
case("same_window", lambda: free_slots(day, "Maple", "10:00", "10:00"))
case("reversed", lambda: free_slots(day, "Maple", "17:00", "09:00"))
case("neg_min", lambda: free_slots(day, "Maple", min_minutes=-5))
case("bad_time", lambda: free_slots(day, "Maple", day_start="8:00"))
'''))
expect(res, "main", ["ok", [["08:45", "11:00"], ["13:00", "16:40"]]])
expect(res, "min136", ["ok", [["13:00", "16:40"]]])
expect(res, "small0", ["ok", [["09:10", "09:20"], ["09:35", "10:00"], ["10:05", "10:10"]]])
expect(res, "small10", ["ok", [["09:10", "09:20"], ["09:35", "10:00"]]])
expect(res, "small11", ["ok", [["09:35", "10:00"]]])
expect(res, "min_exact", ["ok", [["08:45", "11:00"], ["13:00", "16:40"]]])
expect(res, "window", ["ok", [["13:00", "16:40"]]])
expect(res, "full", ["ok", []])
expect(res, "empty_room", ["ok", [["09:05", "09:50"]]])
expect(res, "midnight", ["ok", [["00:00", "23:00"]]])
expect(res, "tuple_type", ["ok", ["tuple", "tuple"]])
for k in ["same_window", "reversed", "neg_min", "bad_time"]:
    expect(res, k, ["err", "ValueError"])
run_visible_tests()
finish()
