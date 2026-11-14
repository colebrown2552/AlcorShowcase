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
NEW, OLD = 3_000_000_000, 1_000_000_000


def write(root, rel, text, mtime):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    os.utime(path, ns=(mtime, mtime))


import atexit
import shutil
tmp = tempfile.mkdtemp()
atexit.register(shutil.rmtree, tmp, True)
src, dst = os.path.join(tmp, "src"), os.path.join(tmp, "dst")
for rel in ["main.py", "notes.tmp", "build/out.o", "lib/build/gen.c", "lib/util.py", "docs/guide.md",
            "docs/draft.md", "docs/api/draft.md", "keep/build.txt", "Cache.TMP"]:
    write(src, rel, "src:" + rel, NEW)
write(dst, "main.py", "older", OLD)
write(dst, "lib/util.py", "src:lib/util.py", NEW)
for rel in ["stale.tmp", "build/old.o", "removed.py", "docs/draft.md"]:
    write(dst, rel, "dst:" + rel, OLD)
os.makedirs(os.path.join(dst, "lib"), exist_ok=True)

res = need(*probe(r'''
from syncplan import plan, scan
src, dst = %r, %r
L = lambda acts: [list(a) for a in acts]
case("scan_md", lambda: sorted(scan(src, ignore=["*.md"])))
case("scan_tuple", lambda: sorted(scan(src, ignore=("build", "lib"))))
case("scan_default", lambda: len(scan(src)))
case("plan_dirs", lambda: L(plan(src, dst, delete=True, ignore=("build", "*.tmp"))))
case("plan_path", lambda: L(plan(src, dst, ignore=["docs/draft.md"])))
case("plan_default", lambda: L(plan(src, dst, delete=True)))
''' % (src, dst)))
expect(res, "scan_md", ["ok", ["Cache.TMP", "build/out.o", "keep/build.txt", "lib/build/gen.c", "lib/util.py",
                               "main.py", "notes.tmp"]])
expect(res, "scan_tuple", ["ok", ["Cache.TMP", "docs/api/draft.md", "docs/draft.md", "docs/guide.md",
                                  "keep/build.txt", "main.py", "notes.tmp"]])
expect(res, "scan_default", ["ok", 10])
expect(res, "plan_dirs", ["ok", [["copy", "Cache.TMP"], ["copy", "docs/api/draft.md"], ["update", "docs/draft.md"],
                                 ["copy", "docs/guide.md"], ["copy", "keep/build.txt"], ["update", "main.py"],
                                 ["delete", "removed.py"]]])
expect(res, "plan_path", ["ok", [["copy", "Cache.TMP"], ["copy", "build/out.o"], ["copy", "docs/api/draft.md"],
                                 ["copy", "docs/guide.md"], ["copy", "keep/build.txt"], ["copy", "lib/build/gen.c"],
                                 ["update", "main.py"], ["copy", "notes.tmp"]]])
expect(res, "plan_default", ["ok", [["copy", "Cache.TMP"], ["delete", "build/old.o"],
                                    ["copy", "build/out.o"], ["copy", "docs/api/draft.md"],
                                    ["update", "docs/draft.md"], ["copy", "docs/guide.md"],
                                    ["copy", "keep/build.txt"], ["copy", "lib/build/gen.c"], ["update", "main.py"],
                                    ["copy", "notes.tmp"], ["delete", "removed.py"], ["delete", "stale.tmp"]]])

r = run_cmd([sys.executable, "-B", "-m", "syncplan", src, dst, "--delete", "--ignore", "*.tmp",
             "--ignore", "build", "--ignore", "docs/*.md", "--ignore", "*.py"])
if r is None:
    fail("cli: timed out")
elif r[0] != 0 or r[1] != "copy Cache.TMP\ncopy keep/build.txt\n":
    fail("cli with ignores: exit %s, stdout %r" % (r[0], r[1]))
r = run_cmd([sys.executable, "-B", "-m", "syncplan", src, dst, "--ignore", "*"])
if r is None or r[:2] != (0, "nothing to do\n"):
    fail("cli ignoring everything: got %r" % (r and r[:2],))
r = run_cmd([sys.executable, "-B", "-m", "syncplan", os.path.join(tmp, "nope"), dst, "--ignore", "x"])
if r is None or r[0] != 2:
    fail("cli with missing SRC should still exit 2, got %r" % (r and r[0],))
try:
    with open(os.path.join(WORK, "README.md"), encoding="utf-8") as fh:
        if "--ignore" not in fh.read():
            fail("README.md does not mention the --ignore option")
except OSError:
    fail("README.md is missing")
run_visible_tests()
finish()
