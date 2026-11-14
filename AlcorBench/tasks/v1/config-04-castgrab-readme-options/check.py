import json, os, subprocess, sys

FAILS = []

# Agent code runs with an explicit minimal environment: nothing inherited.
AGENT_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"}


def fail(msg):
    FAILS.append(msg)


# Ground truth comes from the (protected) code: ask argparse what it accepts.
TRUTH = r'''
import argparse, json
from castgrab.cli import build_parser
rows = {}
for action in build_parser()._actions:
    if not action.option_strings or isinstance(action, argparse._HelpAction) or action.help == argparse.SUPPRESS:
        continue
    name = max((s for s in action.option_strings if s.startswith("--")), key=len)
    d = action.default
    if d is None or d == argparse.SUPPRESS:
        text = "-"
    elif isinstance(d, bool):
        text = "true" if d else "false"
    else:
        text = str(d)
    rows[name] = text
print("@@RESULT@@" + json.dumps(rows))
'''

try:
    p = subprocess.run([sys.executable, "-c", TRUTH], cwd=os.getcwd(), capture_output=True, text=True, env=AGENT_ENV, timeout=20)
    line = [l for l in p.stdout.splitlines() if l.startswith("@@RESULT@@")]
    truth = json.loads(line[-1][10:]) if line else None
except subprocess.TimeoutExpired:
    truth = None
if not truth:
    print("FAIL: could not read the options from castgrab/cli.py")
    sys.exit(1)


def unquote(cell):
    cell = cell.strip()
    if len(cell) >= 2 and cell.startswith("`") and cell.endswith("`"):
        cell = cell[1:-1].strip()
    return cell


try:
    with open("README.md", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
except OSError:
    print("FAIL: README.md missing")
    sys.exit(1)

for heading in ("## Install", "## Usage", "## Feeds file", "## Options"):
    if not any(l.strip() == heading for l in lines):
        fail("README lost its '%s' section" % heading)

start = next((i for i, l in enumerate(lines) if l.strip() == "## Options"), None)
documented = {}
if start is not None:
    for l in lines[start + 1:]:
        if l.startswith("## "):
            break
        s = l.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if all(set(c) <= set("-: ") for c in cells):
            continue
        if cells[0].lower() == "option":
            if [c.lower() for c in cells] != ["option", "default", "description"]:
                fail("table header should be Option | Default | Description, got %r" % cells)
            continue
        if len(cells) != 3:
            fail("table row does not have 3 columns: %r" % s)
            continue
        name, default, desc = unquote(cells[0]), unquote(cells[1]), cells[2]
        if name in documented:
            fail("%s is documented twice" % name)
        if not desc:
            fail("%s has no description" % name)
        documented[name] = default

missing = sorted(set(truth) - set(documented))
extra = sorted(set(documented) - set(truth))
if missing:
    fail("options the tool accepts but the README lacks: %s" % ", ".join(missing))
if extra:
    fail("options documented but not accepted (or hidden): %s" % ", ".join(extra))
wrong = ["%s (README %r, code %r)" % (n, documented[n], truth[n]) for n in sorted(set(truth) & set(documented))
         if documented[n] != truth[n]]
if wrong:
    fail("wrong defaults: %s" % "; ".join(wrong))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
