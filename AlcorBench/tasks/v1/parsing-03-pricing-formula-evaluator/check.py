import ast, json, os, subprocess, sys, tempfile

FAILS = []

# Agent code runs with an explicit minimal environment: nothing inherited.
AGENT_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"}


def fail(msg):
    FAILS.append(msg)


# 1. No eval/exec/compile/ast anywhere in the pricing package.
BANNED_NAMES = {"eval", "exec", "compile", "__import__"}
BANNED_ATTRS = {"eval", "exec", "__import__"}
for root, dirs, files in os.walk("pricing"):
    dirs[:] = [d for d in dirs if not d.startswith(".") and d != "__pycache__"]
    for name in files:
        if not name.endswith(".py"):
            continue
        path = os.path.join(root, name)
        try:
            with open(path, encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), path)
        except (SyntaxError, UnicodeDecodeError, OSError) as exc:
            fail("%s does not parse: %s" % (path, exc))
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func
                if isinstance(fn, ast.Name) and fn.id in BANNED_NAMES:
                    fail("%s:%d calls %s()" % (path, node.lineno, fn.id))
                elif isinstance(fn, ast.Attribute) and (fn.attr in BANNED_ATTRS or (
                        fn.attr == "compile" and isinstance(fn.value, ast.Name) and fn.value.id == "builtins")):
                    fail("%s:%d calls %s()" % (path, node.lineno, fn.attr))
            elif isinstance(node, ast.Import) and any(a.name.split(".")[0] == "ast" for a in node.names):
                fail("%s:%d imports the ast module" % (path, node.lineno))
            elif isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "ast":
                fail("%s:%d imports from the ast module" % (path, node.lineno))

# 2. Behaviour.
DRIVER = r'''
import json, sys
from pricing.errors import FormulaError
from pricing.formula import evaluate
out = []
for expr, variables in json.loads(sys.stdin.read()):
    try:
        value = evaluate(expr, variables)
        out.append({"ok": value} if type(value) is float else {"other": "returned %s" % type(value).__name__})
    except FormulaError as exc:
        out.append({"error": str(exc)})
    except Exception as exc:
        out.append({"other": type(exc).__name__})
print("@@RESULT@@" + json.dumps(out))
'''

V = {"unit_price": 12.5, "qty": 4, "rate": 0.2, "ship_2": 3, "zero": 0}
GOOD = [
    ("unit_price * qty * (1 - rate) + ship_2", V, 43.0),
    ("2 * 3 + 4 * 5", {}, 26.0),
    ("7 - 2 - 1", {}, 4.0),
    ("100 / 10 / 5", {}, 2.0),
    ("10/4", {}, 2.5),
    ("-(2 + 3) * 2", {}, -10.0),
    ("2 * -3", {}, -6.0),
    ("5 - -1", {}, 6.0),
    ("-qty + +2", V, -2.0),
    ("\t( ( 1.25 ) )\t* 8 ", {}, 10.0),
    ("(((((((((((((((((((((1+1)))))))))))))))))))))", {}, 2.0),
    ("1 - 2 * (3 - 4) / (0.5 + 0.5) - 6", {}, -3.0),
    ("+".join(["1"] * 400), {}, 400.0),
    ("qty", V, 4.0),
    ("0.1 + 0.2 - 0.3", {}, 0.0),
]
ERRORS = [
    ("1 / zero", V, "division by zero"),
    ("qty / (rate - 0.2)", V, "division by zero"),
    ("missing_price * 2", V, "unknown variable 'missing_price'"),
    ("(1 + Qty)", V, "unknown variable 'Qty'"),
]
INVALID = [
    "__import__('os').system('touch PWNED')",
    "2 ** 3", "7 % 2", "", "   ", "(1 + 2", "1 + 2)", "()", "3 4", "qty rate", "1 + * 2", "1 +",
    "a.b", "[1]", "'5'", "1, 2", "1 if 1 else 0", "qty.real", "1e3", "5 // 2", "abs(-1)",
]

cases = [[e, v] for e, v, _ in GOOD] + [[e, v] for e, v, _ in ERRORS] + [[e, V] for e in INVALID]
results = None
try:
    p = subprocess.run([sys.executable, "-c", DRIVER], cwd=os.getcwd(), input=json.dumps(cases),
                       capture_output=True, text=True, env=AGENT_ENV, timeout=30)
    for line in reversed(p.stdout.splitlines()):
        if line.startswith("@@RESULT@@"):
            results = json.loads(line[10:])
            break
    if results is None:
        fail("could not call evaluate: %s" % p.stderr.strip()[-200:])
except subprocess.TimeoutExpired:
    fail("evaluate timed out")

if os.path.exists("PWNED"):
    fail("a formula was able to run code (PWNED file created)")
    os.remove("PWNED")

if results is not None:
    i = 0
    for expr, _v, want in GOOD:
        got = results[i]; i += 1
        if "ok" not in got or abs(got["ok"] - want) > 1e-9:
            fail("evaluate(%r): expected float %s, got %s" % (expr[:60], want, json.dumps(got)))
    for expr, _v, msg in ERRORS:
        got = results[i]; i += 1
        if got != {"error": msg}:
            fail("evaluate(%r): expected FormulaError(%r), got %s" % (expr, msg, json.dumps(got)))
    for expr in INVALID:
        got = results[i]; i += 1
        if "error" not in got:
            fail("evaluate(%r): expected FormulaError, got %s" % (expr, json.dumps(got)))

# 3. The rules command still works end to end.
with tempfile.TemporaryDirectory() as tmp:
    order = os.path.join(tmp, "order.json")
    rules = os.path.join(tmp, "rules.json")
    with open(order, "w") as fh:
        json.dump({"unit_price": 8, "qty": 5, "member_rate": 0.25}, fh)
    with open(rules, "w") as fh:
        json.dump({"subtotal": "unit_price * qty", "discount": "subtotal * member_rate",
                   "shipping": "4.95 + 0.5 * (qty - 1)", "total": "subtotal - discount + shipping"}, fh)
    try:
        p = subprocess.run([sys.executable, "-m", "pricing.rules", rules, order], cwd=os.getcwd(),
                           capture_output=True, text=True, env=AGENT_ENV, timeout=20)
        total = json.loads(p.stdout).get("total") if p.returncode == 0 else None
    except (subprocess.TimeoutExpired, ValueError):
        total = None
    if not isinstance(total, float) or abs(total - 36.95) > 1e-9:
        fail("python3 -m pricing.rules: expected total 36.95, got %r" % (total,))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
