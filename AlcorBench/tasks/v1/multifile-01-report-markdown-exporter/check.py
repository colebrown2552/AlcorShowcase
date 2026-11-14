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
from reportkit import export, available_formats
rows = [{"region": "EU|West", "units": 12, "ok": True},
        {"units": 0, "note": "two\nlines"},
        {"region": None, "ok": False, "note": ""}]
case("formats", lambda: [f for f in ["csv", "json", "markdown"] if f in available_formats()])
case("default", lambda: export(rows, "markdown"))
case("right", lambda: export(rows[:1], "markdown", align="right"))
case("center", lambda: export([{"a|b": 1.5}], "markdown", align="center"))
case("empty", lambda: export([], "markdown"))
case("bad_align", lambda: export(rows, "markdown", align="justify"))
case("bad_option", lambda: export(rows, "markdown", delimiter=";"))
case("csv_same", lambda: export(rows, "csv", delimiter=";"))
case("json_same", lambda: export([{"b": 1, "a": None}], "json", indent=None, sort_keys=True))
'''))
expect(res, "formats", ["ok", ["csv", "json", "markdown"]])
expect(res, "default", ["ok",
    "| region | units | ok | note |\n"
    "| :--- | :--- | :--- | :--- |\n"
    "| EU\\|West | 12 | True |  |\n"
    "|  | 0 |  | two lines |\n"
    "|  |  | False |  |\n"])
expect(res, "right", ["ok", "| region | units | ok |\n| ---: | ---: | ---: |\n| EU\\|West | 12 | True |\n"])
expect(res, "center", ["ok", "| a\\|b |\n| :---: |\n| 1.5 |\n"])
expect(res, "empty", ["ok", ""])
expect(res, "bad_align", ["err", "ValueError"])
expect(res, "bad_option", ["err", "ValueError"])
expect(res, "csv_same", ["ok", 'region;units;ok;note\nEU|West;12;True;\n;0;;"two\nlines"\n;;False;\n'])
expect(res, "json_same", ["ok", '[{"a": null, "b": 1}]\n'])

# docs/formats.md must list every registered format with each of its options
doc = need(*probe(r'''
import os
from reportkit import available_formats
from reportkit.config import DEFAULTS
def docs():
    with open(os.path.join(%r, "docs", "formats.md"), encoding="utf-8") as fh:
        rows = [l for l in fh if l.startswith("| `")]
    listed = {l.split("`")[1]: l for l in rows}
    missing = []
    for fmt in available_formats():
        if fmt not in listed:
            missing.append(fmt)
            continue
        missing += ["%%s.%%s" %% (fmt, o) for o in DEFAULTS.get(fmt, {}) if "`%%s`" %% o not in listed[fmt]]
    extra = sorted(set(listed) - set(available_formats()))
    return [missing, extra, sorted(DEFAULTS.get("markdown", {}))]
case("docs", docs)
''' % WORK))
expect(doc, "docs", ["ok", [[], [], ["align"]]])
run_visible_tests()
finish()
