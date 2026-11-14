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
DOC = """# Release notes

## Overview
### Setup
#### Details

## Setup

```
## Setup
```

### Overview
## Setup ##
#### Details
###### Deep
"""
res = need(*probe(r'''
from mdtoc import build_toc
DOC = %r
case("default", lambda: build_toc(DOC))
case("range_2_3", lambda: build_toc(DOC, min_level=2, max_level=3))
case("only_4", lambda: build_toc(DOC, min_level=4, max_level=4))
case("from_3", lambda: build_toc(DOC, 3))
case("none_in_range", lambda: build_toc("# A\n## B\n", min_level=5))
case("bad_order", lambda: build_toc(DOC, min_level=4, max_level=2))
case("bad_low", lambda: build_toc(DOC, min_level=0))
case("bad_high", lambda: build_toc(DOC, max_level=7))
case("triple", lambda: build_toc("## Notes\n## Notes\n## Notes\n", max_level=2))
''' % DOC))
expect(res, "default", ["ok",
    "- [Release notes](#release-notes)\n"
    "  - [Overview](#overview)\n"
    "    - [Setup](#setup)\n"
    "      - [Details](#details)\n"
    "  - [Setup](#setup-1)\n"
    "    - [Overview](#overview-1)\n"
    "  - [Setup](#setup-2)\n"
    "      - [Details](#details-1)\n"
    "          - [Deep](#deep)\n"])
expect(res, "range_2_3", ["ok",
    "- [Overview](#overview)\n"
    "  - [Setup](#setup)\n"
    "- [Setup](#setup-1)\n"
    "  - [Overview](#overview-1)\n"
    "- [Setup](#setup-2)\n"])
expect(res, "only_4", ["ok", "- [Details](#details)\n- [Details](#details-1)\n"])
expect(res, "from_3", ["ok",
    "- [Setup](#setup)\n"
    "  - [Details](#details)\n"
    "- [Overview](#overview-1)\n"
    "  - [Details](#details-1)\n"
    "      - [Deep](#deep)\n"])
expect(res, "none_in_range", ["ok", ""])
expect(res, "bad_order", ["err", "ValueError"])
expect(res, "bad_low", ["err", "ValueError"])
expect(res, "bad_high", ["err", "ValueError"])
expect(res, "triple", ["ok", "  - [Notes](#notes)\n  - [Notes](#notes-1)\n  - [Notes](#notes-2)\n"])
run_visible_tests()
finish()
