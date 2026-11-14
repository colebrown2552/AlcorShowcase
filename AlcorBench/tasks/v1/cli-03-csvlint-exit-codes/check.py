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
FILES = {
    "good.csv": "sku,qty,price\nA-1,3,9.50\n\nB-2,1,0.99\n",
    "bad.csv": "sku,qty,price\nC-3,,1\nD-4,2\n,5,2.00\nE-5,1,1,extra\n",
    "noqty.csv": "sku,price\nF-6,1.00\n",
    "empty.csv": "",
}


def lint(name, args, want_code, want_out, want_err=None, err_prefixes=()):
    with tempfile.TemporaryDirectory() as tmp:
        for fname, text in FILES.items():
            with open(os.path.join(tmp, fname), "w", encoding="utf-8") as fh:
                fh.write(text)
        with open(os.path.join(tmp, "latin1.csv"), "wb") as fh:
            fh.write(b"sku,qty\ncaf\xe9,1\n")
        os.mkdir(os.path.join(tmp, "folder.csv"))
        r = run_cmd([sys.executable, "-B", os.path.join(WORK, "csvlint.py")] + args, cwd=tmp)
    if r is None:
        return fail("%s: timed out" % name)
    code, out, err = r
    if "Traceback" in err:
        return fail("%s: traceback on stderr: %s" % (name, err.strip().splitlines()[-1]))
    if code != want_code:
        return fail("%s: exit %s, expected %s" % (name, code, want_code))
    if out != want_out:
        return fail("%s: stdout %r, expected %r" % (name, out, want_out))
    lines = err.splitlines()
    if want_err is not None:
        problem_lines = [l for l in lines if not l.startswith("csvlint: ")]
        if problem_lines != want_err:
            return fail("%s: stderr problem lines %r, expected %r" % (name, problem_lines, want_err))
    for prefix in err_prefixes:
        if not any(l.startswith(prefix) for l in lines):
            fail("%s: no stderr line starting %r (got %r)" % (name, prefix, lines))


BAD_ERR = ["bad.csv:2: empty value in required column qty",
           "bad.csv:3: expected 3 fields, got 2",
           "bad.csv:4: empty value in required column sku",
           "bad.csv:5: expected 3 fields, got 4"]
lint("clean", ["good.csv", "--require", "sku"], 0, "good.csv: 2 rows, 0 problems\n", [])
lint("clean_quiet", ["-q", "good.csv"], 0, "", [])
lint("problems", ["good.csv", "bad.csv", "--require", "sku", "--require", "qty"], 1,
     "good.csv: 2 rows, 0 problems\nbad.csv: 4 rows, 4 problems\n", BAD_ERR)
lint("problems_quiet", ["--quiet", "bad.csv", "--require", "qty", "--require", "sku"], 1, "", BAD_ERR)
lint("missing_col", ["noqty.csv", "--require", "qty"], 1, "noqty.csv: 1 rows, 1 problems\n",
     ["noqty.csv:1: missing required column: qty"])
lint("empty_file", ["empty.csv"], 1, "empty.csv: 0 rows, 1 problems\n", ["empty.csv:1: empty file: no header"])
lint("missing_file_first", ["nope.csv", "good.csv"], 2, "good.csv: 2 rows, 0 problems\n", [],
     ["csvlint: cannot read nope.csv"])
lint("unreadable_beats_problems", ["bad.csv", "folder.csv", "latin1.csv", "--require", "sku", "-q"], 2, "",
     [l for l in BAD_ERR if "sku" in l or "fields" in l],
     ["csvlint: cannot read folder.csv", "csvlint: cannot read latin1.csv"])
r = run_cmd([sys.executable, "-B", "csvlint.py"])
if r is None or r[0] != 2:
    fail("no arguments: expected argparse exit 2, got %r" % (r and r[0],))
run_visible_tests()
finish()
