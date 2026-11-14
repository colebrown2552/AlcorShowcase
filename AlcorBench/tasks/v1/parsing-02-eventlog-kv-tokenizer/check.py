import json, os, subprocess, sys

FAILS = []

# Agent code runs with an explicit minimal environment: nothing inherited.
AGENT_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"}


def fail(msg):
    FAILS.append(msg)


DRIVER = r'''
import json, sys
from eventlog.errors import KVSyntaxError
from eventlog.kv import parse_line
out = []
for line in json.loads(sys.stdin.read()):
    try:
        res = parse_line(line)
        out.append({"ok": res} if isinstance(res, dict) else {"other": "returned %s" % type(res).__name__})
    except KVSyntaxError:
        out.append({"syntax": True})
    except Exception as exc:
        out.append({"other": type(exc).__name__})
print("@@RESULT@@" + json.dumps(out))
'''

GOOD = [
    ('level=info msg="disk almost full" path="D:\\\\spool\\\\a b"', {"level": "info", "msg": "disk almost full", "path": "D:\\spool\\a b"}),
    ("a=1   b=2\tc=3\n", {"a": "1", "b": "2", "c": "3"}),
    ("\t empty= other=\"\" last=x \r\n", {"empty": "", "other": "", "last": "x"}),
    ("q=a=b sql=\"x = 'y'\"", {"q": "a=b", "sql": "x = 'y'"}),
    ('msg="say \\"hi\\"\\n\\tbye" n=1', {"msg": 'say "hi"\n\tbye', "n": "1"}),
    ("k=1 k=2 K=3", {"k": "2", "K": "3"}),
    ("x.y-z=ok _p=1 a9=-2.5e3", {"x.y-z": "ok", "_p": "1", "a9": "-2.5e3"}),
    ('who="Zoë Ünal" s="ends with backslash \\\\"', {"who": "Zoë Ünal", "s": "ends with backslash \\"}),
    ("   ", {}),
    ("", {}),
    ("\n", {}),
]
BAD = [
    "novalue",
    "a=1 junk",
    "=x",
    "1a=b",
    "-a=b",
    'msg="open',
    'm="bad \\q"',
    'a="x"y',
    'a=b"c',
    "a = b",
    "a =b",
    'm="trailing \\',
    'a="x""y"',
    'a="x"b=1',
]

payload = [g[0] for g in GOOD] + BAD
p = None
try:
    p = subprocess.run([sys.executable, "-c", DRIVER], cwd=os.getcwd(), input=json.dumps(payload),
                       capture_output=True, text=True, env=AGENT_ENV, timeout=20)
except subprocess.TimeoutExpired:
    fail("parse_line timed out")
results = None
if p is not None:
    for line in reversed(p.stdout.splitlines()):
        if line.startswith("@@RESULT@@"):
            results = json.loads(line[10:])
            break
    if results is None:
        fail("could not call parse_line: %s" % p.stderr.strip()[-200:])
if results is not None:
    for (line, want), got in zip(GOOD, results):
        if got != {"ok": want}:
            fail("parse_line(%r): expected %s, got %s" % (line, json.dumps(want), json.dumps(got)))
    for line, got in zip(BAD, results[len(GOOD):]):
        if got != {"syntax": True}:
            fail("parse_line(%r): expected KVSyntaxError, got %s" % (line, json.dumps(got)))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
