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
import datetime
from habits import longest_streak, parse_journal
D = datetime.date
def S(days):
    s = longest_streak(days)
    return [s.length, s.start and s.start.isoformat(), s.end and s.end.isoformat()]
def span(a, n):
    return [a + datetime.timedelta(days=i) for i in range(n)]
case("empty", lambda: S([]))
case("single", lambda: S([D(2025, 6, 9)]))
case("dupes", lambda: S([D(2025, 6, 9), D(2025, 6, 10), D(2025, 6, 10), D(2025, 6, 11), D(2025, 6, 9)]))
case("leap", lambda: S(span(D(2028, 2, 27), 4) + [D(2028, 2, 20)]))
case("new_year", lambda: S(list(reversed(span(D(2025, 12, 30), 3))) + span(D(2025, 12, 1), 2)))
case("tie_earliest", lambda: S(span(D(2026, 5, 10), 3) + span(D(2026, 1, 4), 3) + [D(2026, 3, 1)]))
case("later_longer", lambda: S(span(D(2026, 1, 1), 2) + span(D(2026, 1, 4), 5) + span(D(2026, 1, 11), 1)))
case("generator", lambda: S(d for d in span(D(2024, 2, 28), 2) + span(D(2024, 3, 5), 1)))
case("from_set", lambda: S(parse_journal(
    "2026-04-02 swim\n2026-04-01 swim\n2026-03-31 swim\n2026-04-05 swim\n2026-04-04 swim\n")["swim"]))
case("non_leap", lambda: S([D(2027, 2, 28), D(2027, 3, 1), D(2027, 2, 27), D(2027, 3, 3)]))
'''))
expect(res, "empty", ["ok", [0, None, None]])
expect(res, "single", ["ok", [1, "2025-06-09", "2025-06-09"]])
expect(res, "dupes", ["ok", [3, "2025-06-09", "2025-06-11"]])
expect(res, "leap", ["ok", [4, "2028-02-27", "2028-03-01"]])
expect(res, "new_year", ["ok", [3, "2025-12-30", "2026-01-01"]])
expect(res, "tie_earliest", ["ok", [3, "2026-01-04", "2026-01-06"]])
expect(res, "later_longer", ["ok", [5, "2026-01-04", "2026-01-08"]])
expect(res, "generator", ["ok", [2, "2024-02-28", "2024-02-29"]])
expect(res, "from_set", ["ok", [3, "2026-03-31", "2026-04-02"]])
expect(res, "non_leap", ["ok", [3, "2027-02-27", "2027-03-01"]])
run_visible_tests()
finish()
