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
from minitpl import render
class Acct:
    tier = "Gold Plus"
ctx = {"first": "grace", "title": "Quarterly Statement", "n": 1234567, "empty": "", "none": None,
       "acct": Acct(), "u": {"city": "Lyon"}}
T = {
    "upper_nospace": "{{first|upper}}",
    "lower_attr": "[{{ acct.tier | lower }}]",
    "chain": "{{ title | upper | truncate:9 }}!",
    "chain_order": "{{ title | truncate:9 | upper }}",
    "trunc_exact": "{{ first | truncate:5 }}",
    "trunc_zero": "{{ first | truncate:0 }}",
    "trunc_int": "{{ n|truncate:3 }}",
    "default_missing": "Hi {{ nick | default:\"there, friend\" }}.",
    "default_empty": "{{ empty | default:\"n/a\" }}",
    "default_none": "{{ none | default:\"x:y\" }}",
    "default_present": "{{ u.city | default:\"?\" }}",
    "default_then_upper": "{{ missing.deep | default:\"tbd\" | upper }}",
    "upper_then_default": "{{ missing | upper | default:\"Unset\" }}",
    "two_tags": "{{ first|upper }}-{{ u.city|lower|truncate:2 }}",
    "plain": "{{ n }} {{ u.city }}",
}
for k, t in T.items():
    case(k, (lambda t=t: render(t, ctx)))
BAD = {"unknown": "{{ first | shout }}", "missing_no_default": "{{ ghost | upper }}",
       "trunc_str": '{{ first | truncate:"5" }}', "trunc_neg": "{{ first | truncate:-1 }}",
       "default_int": "{{ first | default:3 }}", "default_bare": "{{ first | default }}",
       "upper_arg": "{{ first | upper:2 }}"}
for k, t in BAD.items():
    case(k, (lambda t=t: render(t, ctx)))
'''))
want = {
    "upper_nospace": "GRACE", "lower_attr": "[gold plus]", "chain": "QUARTERLY...!",
    "chain_order": "QUARTERLY...", "trunc_exact": "grace", "trunc_zero": "...", "trunc_int": "123...",
    "default_missing": "Hi there, friend.", "default_empty": "n/a", "default_none": "x:y",
    "default_present": "Lyon", "default_then_upper": "TBD", "upper_then_default": "Unset",
    "two_tags": "GRACE-ly...", "plain": "1234567 Lyon",
}
for k, v in want.items():
    expect(res, k, ["ok", v])
for k in ["unknown", "missing_no_default", "trunc_str", "trunc_neg", "default_int", "default_bare",
          "upper_arg"]:
    expect(res, k, ["err", "TemplateError"])
run_visible_tests()
finish()
