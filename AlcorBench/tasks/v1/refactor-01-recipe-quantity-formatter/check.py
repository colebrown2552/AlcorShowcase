"""Acceptance check: one shared format_quantity, outputs unchanged."""
import ast
import json
import os
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

SAMPLES = r'''
import json, os, random, sys
from fractions import Fraction
sys.path.insert(0, os.getcwd())
from recipes.scale import scale_recipe
from recipes.shopping import shopping_list

rng = random.Random(4242)
qtys = ["1", "2", "3", "1/2", "1/3", "2/3", "1/4", "3/4", "1/8", "1 1/2", "2 1/4", "0.75", "2.5",
        "0.1", "7", "12", "250", "1/5", "5/8", "0", "0.33"]
units = ["cup", "cups", "tbsp", "tsp", "g", "ml", "pinch", "clove", "cloves", ""]
names = ["flour", "Flour", "sugar", "butter", "garlic", "eggs", "milk", "salt", "rice", "lemon zest"]

def line():
    u = rng.choice(units)
    return " ".join(p for p in (rng.choice(qtys), u, rng.choice(names)) if p)

results = []
for _ in range(120):
    lines = [line() for _ in range(rng.randint(1, 6))]
    f, t = rng.randint(1, 12), rng.randint(1, 12)
    results.append(["scale", lines, f, t, scale_recipe(lines, f, t)])
for _ in range(80):
    recs = []
    for _ in range(rng.randint(1, 4)):
        recs.append(([line() for _ in range(rng.randint(1, 5))], Fraction(rng.randint(1, 9), rng.randint(1, 6))))
    results.append(["shop", [[l, str(fac)] for l, fac in recs], shopping_list(recs)])
print(json.dumps(results, ensure_ascii=False))
'''

USES_SHARED = r'''
import os, sys
sys.path.insert(0, os.getcwd())
import recipes.units as units
import recipes.scale as scale_mod
import recipes.shopping as shopping_mod
real = units.format_quantity
calls = []
def spy(value):
    calls.append(value)
    return real(value)
units.format_quantity = spy
for mod in (scale_mod, shopping_mod):
    for name, obj in list(vars(mod).items()):
        if obj is real:
            setattr(mod, name, spy)
scale_recipe = scale_mod.scale_recipe
shopping_list = shopping_mod.shopping_list
scale_recipe(["1 1/2 cup oats", "2 tsp honey"], 2, 3)
n_scale = len(calls)
shopping_list([(["1/3 cup oats", "2 g salt"], 2)])
n_shop = len(calls) - n_scale
print(n_scale, n_shop)
'''


def run(code, cwd):
    env = clean_env(cwd)
    try:
        p = subprocess.run([sys.executable, "-c", code], cwd=cwd, env=env, capture_output=True,
                           text=True, timeout=12, encoding="utf-8")
    except subprocess.TimeoutExpired:
        return None, "timed out"
    return p.returncode, p.stdout if p.returncode == 0 else (p.stdout + p.stderr)


def main():
    fails = []

    scratch = tempfile.mkdtemp(prefix="rf1-")
    try:
        orig = os.path.join(scratch, "orig")
        shutil.copytree(os.path.join(TASK_DIR, "fixture"), orig)
        rc, expected = run(SAMPLES, orig)
        if rc != 0:
            print("FAIL: internal: original code could not produce samples")
            return 1
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    rc, got = run(SAMPLES, WORK)
    if rc != 0:
        fails.append("running scale_recipe/shopping_list failed: " + (got or "").strip()[-400:])
    else:
        exp, act = json.loads(expected), json.loads(got)
        for e, a in zip(exp, act):
            if e != a:
                fails.append(f"output changed for {e[0]} input {e[1]!r}: expected {e[-1]!r}, got {a[-1]!r}")
                break

    rc, out = run(USES_SHARED, WORK)
    if rc != 0:
        fails.append("could not call recipes.units.format_quantity: " + (out or "").strip()[-300:])
    else:
        n_scale, n_shop = (int(x) for x in out.split())
        if n_scale == 0:
            fails.append("scale_recipe does not use recipes.units.format_quantity")
        if n_shop == 0:
            fails.append("shopping_list does not use recipes.units.format_quantity")

    glyphs = set("¼⅓½⅔¾⅛")
    for rel in ("recipes/scale.py", "recipes/shopping.py"):
        try:
            tree = ast.parse(open(os.path.join(WORK, rel), encoding="utf-8").read())
        except (OSError, SyntaxError) as e:
            fails.append(f"cannot parse {rel}: {e}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr == "limit_denominator":
                fails.append(f"{rel} still contains its own quantity-formatting logic")
                break
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and glyphs & set(node.value):
                fails.append(f"{rel} still contains its own fraction glyph table")
                break

    env = clean_env(WORK)
    try:
        t = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                           cwd=WORK, env=env, capture_output=True, text=True, timeout=12)
        if t.returncode != 0:
            fails.append("existing tests in tests/ fail: " + t.stderr.strip()[-400:])
    except subprocess.TimeoutExpired:
        fails.append("existing tests timed out")

    for f in fails:
        print("FAIL:", f)
    if not fails:
        print("PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
