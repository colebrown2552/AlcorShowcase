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
from semverlite import parse, Version
b = lambda s, part: str(parse(s).bump(part))
cases = {
    "patch_plain": ("0.9.9", "patch"), "patch_pre": ("3.0.7-alpha.2", "patch"),
    "patch_build": ("1.1.1+ci.4", "patch"), "patch_pre_build": ("5.4.0-rc.1+b9", "patch"),
    "minor_plain": ("0.9.9", "minor"), "minor_pre_zero": ("2.5.0-beta", "minor"),
    "minor_pre_nonzero": ("2.5.1-beta", "minor"), "minor_build": ("4.0.0+x", "minor"),
    "major_plain": ("9.9.9", "major"), "major_pre_zero": ("10.0.0-rc.3", "major"),
    "major_pre_minor": ("10.1.0-rc.3", "major"), "major_pre_patch": ("10.0.2-rc.3", "major"),
    "major_zero": ("0.0.0", "major"),
}
for name, (s, part) in cases.items():
    case(name, (lambda s=s, part=part: b(s, part)))
case("bad_part", lambda: str(parse("1.0.0").bump("build")))
case("bad_part_case", lambda: str(parse("1.0.0").bump("Major")))
def unchanged():
    v = parse("1.2.3-rc.1+m")
    v.bump("minor")
    return str(v)
case("unchanged", unchanged)
case("returns_version", lambda: isinstance(parse("1.2.3").bump("patch"), Version))
case("no_pre_on_result", lambda: [parse("3.0.0-x").bump("major").prerelease, parse("3.0.0-x+y").bump("major").build])
'''))
want = {
    "patch_plain": "0.9.10", "patch_pre": "3.0.7", "patch_build": "1.1.2", "patch_pre_build": "5.4.0",
    "minor_plain": "0.10.0", "minor_pre_zero": "2.5.0", "minor_pre_nonzero": "2.6.0", "minor_build": "4.1.0",
    "major_plain": "10.0.0", "major_pre_zero": "10.0.0", "major_pre_minor": "11.0.0",
    "major_pre_patch": "11.0.0", "major_zero": "1.0.0",
}
for k, v in want.items():
    expect(res, k, ["ok", v])
expect(res, "bad_part", ["err", "ValueError"])
expect(res, "bad_part_case", ["err", "ValueError"])
expect(res, "unchanged", ["ok", "1.2.3-rc.1+m"])
expect(res, "returns_version", ["ok", True])
expect(res, "no_pre_on_result", ["ok", ["", ""]])
run_visible_tests()
finish()
