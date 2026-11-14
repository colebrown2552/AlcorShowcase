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
BASE = ("# service config\n"
        "API_URL=https://api.example.test\n"
        "export TOKEN_TTL=300\n"
        "\n"
        "   REDIS = redis://cache:6379   \n"
        "REDIS_POOL=8\n"
        "# REDIS=commented-out stays\n"
        "not a definition\n"
        "TOKEN_TTL=600\n"
        "MODE=dev\n")


def scenario(name, args, want_file, want_code, want_out="", err_lines=(), content=BASE):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "app.env")
        if content is not None:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(content)
        r = run_cmd([sys.executable, "-B", os.path.join(WORK, "envtool.py"), "--file", path] + args,
                    cwd=tmp)
        if r is None:
            return fail("%s: timed out" % name)
        code, out, err = r
        if code != want_code:
            return fail("%s: exit %s, expected %s (stderr %r)" % (name, code, want_code, err[-150:]))
        if out != want_out:
            return fail("%s: stdout %r, expected %r" % (name, out[:200], want_out[:200]))
        got_err = [l for l in err.splitlines() if l.strip()]
        for line in err_lines:
            if line not in got_err:
                return fail("%s: stderr missing line %r (got %r)" % (name, line, got_err))
        if want_code == 0 and got_err:
            return fail("%s: unexpected stderr %r" % (name, got_err))
        if want_file is None:
            if os.path.exists(path):
                fail("%s: file was created" % name)
        else:
            with open(path, encoding="utf-8") as fh:
                now = fh.read()
            if now != want_file:
                fail("%s: file is %r, expected %r" % (name, now, want_file))


WITHOUT_TTL_REDIS = ("# service config\n"
                     "API_URL=https://api.example.test\n"
                     "\n"
                     "REDIS_POOL=8\n"
                     "# REDIS=commented-out stays\n"
                     "not a definition\n"
                     "MODE=dev\n")
scenario("two_keys", ["unset", "TOKEN_TTL", "REDIS"], WITHOUT_TTL_REDIS, 0)
scenario("one_missing", ["unset", "GHOST", "REDIS", "TOKEN_TTL", "PHANTOM"], WITHOUT_TTL_REDIS, 1,
         err_lines=["envtool: no such key: GHOST", "envtool: no such key: PHANTOM"])
scenario("prefix_safe", ["unset", "API"], BASE, 1, err_lines=["envtool: no such key: API"])
scenario("dry_run", ["unset", "--dry-run", "MODE", "TOKEN_TTL", "REDIS"], BASE, 0,
         want_out=WITHOUT_TTL_REDIS.replace("MODE=dev\n", ""))
scenario("dry_run_missing", ["unset", "NOPE", "--dry-run"], BASE, 1, want_out=BASE,
         err_lines=["envtool: no such key: NOPE"])
scenario("invalid", ["unset", "MODE", "bad-key"], BASE, 2, err_lines=["envtool: invalid key: bad-key"])
scenario("missing_file", ["unset", "MODE"], None, 1, err_lines=["envtool: no such key: MODE"],
         content=None)
scenario("everything", ["unset", "API_URL", "TOKEN_TTL", "REDIS", "REDIS_POOL", "MODE"],
         "# service config\n\n# REDIS=commented-out stays\nnot a definition\n", 0)
r = run_cmd([sys.executable, "-B", "envtool.py", "unset"])
if r is None or r[0] != 2:
    fail("unset with no keys should be a usage error (exit 2), got %r" % (r and r[0],))
run_visible_tests()
finish()
