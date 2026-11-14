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
LOG = "".join([
    "2026-07-04T00:00:00 WARNING low memory\n",
    "2026-07-04T00:00:01 DEBUG cache miss\n",
    "garbage\n",
    "2026-07-04T00:00:02 CRITICAL replica down\n",
    "2026-07-04T00:00:03 WARNING low memory again\n",
    "2026-07-04T00:00:04 info lowercase does not count\n",
    "2026-07-04T00:00:05 DEBUG\n",
])
PY = [sys.executable, "-B", "logstat.py"]

def chk(name, args, stdin, want_out, want_code=0, want_err_has=None):
    r = run_cmd(PY + args, stdin=stdin)
    if r is None:
        return fail("%s: timed out (args %r)" % (name, args))
    code, out, err = r
    if code != want_code:
        return fail("%s: exit %s, expected %s; stderr: %s" % (name, code, want_code, err.strip()[-150:]))
    if out != want_out:
        return fail("%s: stdout %r, expected %r" % (name, out, want_out))
    if want_err_has and want_err_has not in err:
        fail("%s: stderr %r lacks %r" % (name, err, want_err_has))

ALL = "DEBUG 2\nWARNING 2\nCRITICAL 1\n"
chk("stdin_no_arg", [], LOG, ALL)
chk("stdin_dash", ["-"], LOG, ALL)
chk("stdin_level", ["--level", "WARNING"], LOG, "WARNING 2\n")
chk("dash_level_after", ["-", "--level", "INFO"], LOG, "INFO 0\n")
chk("stdin_empty", [], "", "")
chk("stdin_empty_level", ["--level", "ERROR"], "", "ERROR 0\n")
with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "x.log")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(LOG + "2026-07-04T00:00:06 ERROR boom\n")
    chk("file_still_works", [path], "2026-07-04T00:00:00 INFO ignored stdin\n", "DEBUG 2\nWARNING 2\nERROR 1\nCRITICAL 1\n")
    chk("missing_file", [os.path.join(tmp, "nope.log")], LOG, "", 2, "cannot read")
r = run_cmd(PY + ["--help"])
if r is None or r[0] != 0:
    fail("--help: did not exit 0")
elif "stdin" not in r[1].lower() and "standard input" not in " ".join(r[1].lower().split()):
    fail("--help output does not mention stdin / standard input")
run_visible_tests()
finish()
