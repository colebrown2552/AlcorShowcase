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
from sizes import parse_size, format_size
OK = {"plain": "7", "spaced": "\t 1024 B \n", "lower_mb": "3mb", "upper_kib": "10 KIB",
      "frac_mib": "2.5 MiB", "leading_dot": ".5 kB", "floor": "1.0007 kB", "exact_gb": "8.2 GB",
      "exact_tb": "4.35 TB", "exact_kb": "2.01 kB", "exact_tib": "0.1 TiB", "zero": "0 GiB", "big": "123456.789 GB",
      "tiny_floor": "0.0001 kB", "b_lower": "15 b"}
for k, t in OK.items():
    case(k, (lambda t=t: parse_size(t)))
BAD = {"empty": "", "blank": "   ", "neg": "-1 kB", "plus": "+1 kB", "exp": "1e3",
       "unit_only": "GiB", "two_dots": "1.2.3 MB", "unknown": "4 PB", "word": "4 bytes",
       "comma": "1,000 B", "trailing": "5 MB extra"}
for k, t in BAD.items():
    case(k, (lambda t=t: parse_size(t)))
case("round_trip", lambda: [parse_size(format_size(n, binary=bn)) for n, bn in
                            [(3 * 2**30, True), (5 * 10**6, False), (999, False)]])
'''))
want = {"plain": 7, "spaced": 1024, "lower_mb": 3000000, "upper_kib": 10240, "frac_mib": 2621440,
        "leading_dot": 500, "floor": 1000, "exact_gb": 8200000000, "exact_tb": 4350000000000, "exact_kb": 2010,
        "exact_tib": 109951162777, "zero": 0, "big": 123456789000000, "tiny_floor": 0, "b_lower": 15}
for k, v in want.items():
    expect(res, k, ["ok", v])
for k in ["empty", "blank", "neg", "plus", "exp", "unit_only", "two_dots", "unknown", "word",
          "comma", "trailing"]:
    expect(res, k, ["err", "ValueError"])
expect(res, "round_trip", ["ok", [3 * 2**30, 5 * 10**6, 999]])
run_visible_tests()
finish()
