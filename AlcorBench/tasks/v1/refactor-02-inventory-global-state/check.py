"""Acceptance check: Inventory class, no module-level state, CLI unchanged."""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TASK_DIR = str(Path(__file__).resolve().parent)
WORK = os.getcwd()


def clean_env(code_dir):
    """Minimal environment for running code from ``code_dir`` (nothing inherited but PATH)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": code_dir,
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}

SESSIONS = [
    [["receive", "BOLT-M6", "40"], ["receive", "NUT-M6", "3"], ["ship", "BOLT-M6", "38"], ["level", "BOLT-M6"],
     ["level", "GHOST"], ["report"], ["report", "--threshold", "1"], ["history"]],
    [["receive", "A1", "10"], ["ship", "A1", "11"], ["ship", "A1", "0"], ["receive", "B2", "-4"], ["ship", "ZZ", "1"],
     ["level", "A1"], ["history"], ["report", "--threshold", "100"]],
    [["report"], ["history"], ["receive", "PIPE-15MM", "7"], ["receive", "PIPE-15MM", "1"], ["ship", "PIPE-15MM", "8"],
     ["report", "--threshold", "0"], ["receive", "CAP", "6"], ["report"]],
]

API_PROBE = r'''
import os, sys
sys.path.insert(0, os.getcwd())
from stockroom.inventory import Inventory, InsufficientStock
from stockroom import report
fails = []
a, b = Inventory(), Inventory()
if a.receive("X", 5) != 5 or a.receive("X", 2) != 7:
    fails.append("receive should return the new level")
b.receive("Y", 1)
if b.level("X") != 0 or a.level("Y") != 0 or a.history() == b.history():
    fails.append("two Inventory objects share state")
if Inventory().all_levels() != {}:
    fails.append("a new Inventory is not empty")
if a.ship("X", 7) != 0:
    fails.append("ship should return the new level")
try:
    b.ship("Y", 2)
    fails.append("shipping more than in stock should raise InsufficientStock")
except InsufficientStock:
    pass
if not issubclass(InsufficientStock, ValueError):
    fails.append("InsufficientStock must stay a ValueError")
for bad in (("", 1), ("Q", 0), ("Q", -3), ("Q", 1.5)):
    try:
        a.receive(*bad)
        fails.append(f"receive{bad} should raise ValueError")
    except ValueError:
        pass
c = Inventory()
for sku, n in (("M", 4), ("C", 9), ("Z", 1)):
    c.receive(sku, n)
c.ship("C", 2)
lv = c.all_levels()
if list(lv.items()) != [("C", 7), ("M", 4), ("Z", 1)]:
    fails.append(f"all_levels() gave {lv}")
lv["C"] = 999
c.history().append(("x", "y", 1))
if c.level("C") != 7 or len(c.history()) != 4:
    fails.append("changing the result of all_levels()/history() changed the inventory")
want = {"levels": {"C": 7, "M": 4, "Z": 1},
        "history": [["receive", "M", 4], ["receive", "C", 9], ["receive", "Z", 1], ["ship", "C", 2]]}
if c.to_dict() != want:
    fails.append(f"to_dict() format changed: {c.to_dict()}")
d = Inventory.from_dict(want)
if not isinstance(d, Inventory) or d.level("M") != 4 or d.history() != [tuple(h) for h in want["history"]]:
    fails.append("from_dict() does not restore levels and history")
if d.to_dict() != want:
    fails.append("from_dict(x).to_dict() != x")
if Inventory.from_dict({}).all_levels() != {}:
    fails.append("from_dict({}) should give an empty inventory")
r = report.low_stock_report(c, 4)
if r != "2 of 3 SKUs at or below 4:\n  Z                1\n  M                4":
    fails.append(f"low_stock_report(inv, 4) gave {r!r}")
if report.low_stock_report(Inventory()) != "All 0 SKUs above 5.":
    fails.append("low_stock_report on an empty inventory changed")
if report.low_stock_report(c) != report.low_stock_report(c, threshold=5):
    fails.append("threshold should default to 5")
for f in fails:
    print("FAIL:", f)
sys.exit(1 if fails else 0)
'''


def run_cli_session(code_dir, session, scratch):
    state = os.path.join(scratch, "stock.json")
    transcript = []
    for cmd in session:
        try:
            p = subprocess.run([sys.executable, "-m", "stockroom.cli", "--state", state, *cmd], cwd=code_dir,
                               env=clean_env(code_dir), capture_output=True, text=True, timeout=4)
            transcript.append((cmd, p.returncode, p.stdout, p.stderr.strip().splitlines()[-1:] if p.stderr else []))
        except subprocess.TimeoutExpired:
            transcript.append((cmd, "timeout", "", []))
            break
    final = open(state, encoding="utf-8").read() if os.path.exists(state) else None
    return transcript, (json.loads(final) if final else None)


def module_state_problems(path, rel):
    problems = []
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except SyntaxError as e:
        return [f"{rel} does not parse: {e}"]
    mutable_calls = {"dict", "list", "set", "defaultdict", "OrderedDict", "deque", "Counter", "Inventory", "bytearray"}
    for node in tree.body:
        targets, value = [], None
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        names = [t.id for t in targets if isinstance(t, ast.Name)]
        if value is None or names == ["__all__"]:
            continue
        mutable = isinstance(value, (ast.Dict, ast.List, ast.Set, ast.DictComp, ast.ListComp, ast.SetComp))
        if isinstance(value, ast.Call):
            fn = value.func
            name = fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else ""
            mutable = mutable or name in mutable_calls
        if mutable:
            problems.append(f"{rel} line {node.lineno}: module-level mutable state ({', '.join(names) or 'assignment'})")
    for node in ast.walk(tree):
        if isinstance(node, ast.Global):
            problems.append(f"{rel} line {node.lineno}: uses a global statement")
    return problems


def main():
    fails = []
    pkg = os.path.join(WORK, "stockroom")
    for name in sorted(os.listdir(pkg)) if os.path.isdir(pkg) else []:
        if name.endswith(".py"):
            fails += module_state_problems(os.path.join(pkg, name), f"stockroom/{name}")

    try:
        p = subprocess.run([sys.executable, "-c", API_PROBE], cwd=WORK, env=clean_env(WORK), capture_output=True, text=True, timeout=10)
        if p.returncode != 0:
            fails.append("Inventory API: " + (p.stdout + p.stderr).strip()[-700:])
    except subprocess.TimeoutExpired:
        fails.append("Inventory API probe timed out")

    scratch = tempfile.mkdtemp(prefix="rf2-")
    try:
        orig = os.path.join(scratch, "orig")
        shutil.copytree(os.path.join(TASK_DIR, "fixture"), orig)
        for i, session in enumerate(SESSIONS):
            d1, d2 = os.path.join(scratch, f"o{i}"), os.path.join(scratch, f"n{i}")
            os.makedirs(d1)
            os.makedirs(d2)
            want = run_cli_session(orig, session, d1)
            got = run_cli_session(WORK, session, d2)
            if want != got:
                for (cmd, *w), (_, *g) in zip(want[0], got[0]):
                    if w != g:
                        fails.append(f"CLI behaviour changed for `{' '.join(cmd)}`: expected {w}, got {g}")
                        break
                else:
                    fails.append("CLI state file contents changed")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    try:
        t = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                           cwd=WORK, env=clean_env(WORK), capture_output=True, text=True, timeout=12)
        m = re.search(r"^Ran (\d+) tests?", t.stderr, re.M)
        if t.returncode != 0:
            fails.append("tests in tests/ fail: " + t.stderr.strip()[-400:])
        elif not m or int(m.group(1)) < 5:
            fails.append("tests/test_inventory.py lost tests (expected at least the original 5)")
    except subprocess.TimeoutExpired:
        fails.append("tests timed out")

    for f in fails[:8]:
        print("FAIL:", f)
    if not fails:
        print("PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
