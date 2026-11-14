import json, os, subprocess, sys, tempfile

FAILS = []

# Agent code runs with an explicit minimal environment: nothing inherited.
AGENT_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"}


def fail(msg):
    FAILS.append(msg)


def run(args, stdin=None, timeout=20):
    try:
        return subprocess.run(args, cwd=os.getcwd(), input=stdin, capture_output=True, text=True, env=AGENT_ENV, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


DRIVER = r'''
import json, sys
from labelrelay.validate import validate
out = []
for cfg in json.loads(sys.stdin.read()):
    try:
        res = validate(cfg)
        out.append(sorted(res) if isinstance(res, list) and all(isinstance(m, str) for m in res) else {"bad": repr(res)})
    except Exception as exc:
        out.append({"raised": "%s: %s" % (type(exc).__name__, exc)})
print("@@RESULT@@" + json.dumps(out))
'''

P = lambda **kw: dict({"name": "p", "host": "h", "media": "letter"}, **kw)
CASES = [
    ("valid with defaults", {"queue_name": "q", "printers": [P()]}, []),
    ("valid full", {"queue_name": "q", "printers": [P(name="a", port=1), P(name="b", port=65535, media="label-4x6")],
                    "retry": {"attempts": 0, "backoff_s": 0}, "default_printer": "b"}, []),
    ("empty object", {}, ["printers: required", "queue_name: required"]),
    ("not an object", ["queue_name"], ["config: must be an object"]),
    ("bad top-level types", {"queue_name": "", "printers": [], "retry": [1], "default_printer": 7, "colour": "red"},
     ["colour: unknown key", "default_printer: must be a string", "printers: must be a non-empty list",
      "queue_name: must be a non-empty string", "retry: must be an object"]),
    ("printer problems", {"queue_name": "lab", "printers": [
        P(name="a", port="9100"),
        "b",
        P(name="a", port=True, media="Letter", tray=2),
        {"host": "", "port": 0},
        P(name="c", port=65536),
        P(name=5, port=9100.0),
        P(name="a"),
    ], "default_printer": "z"},
     ["default_printer: unknown printer 'z'",
      "printers[0].port: must be an integer between 1 and 65535",
      "printers[1]: must be an object",
      "printers[2].media: must be one of label-2x1, label-4x6, letter",
      "printers[2].name: duplicate name 'a'",
      "printers[2].port: must be an integer between 1 and 65535",
      "printers[2].tray: unknown key",
      "printers[3].host: must be a non-empty string",
      "printers[3].media: required",
      "printers[3].name: required",
      "printers[3].port: must be an integer between 1 and 65535",
      "printers[4].port: must be an integer between 1 and 65535",
      "printers[5].name: must be a non-empty string",
      "printers[5].port: must be an integer between 1 and 65535",
      "printers[6].name: duplicate name 'a'"]),
    ("retry problems", {"queue_name": "q", "printers": [P()], "retry": {"attempts": 11, "backoff_s": -0.5, "jitter": 1}},
     ["retry.attempts: must be an integer between 0 and 10", "retry.backoff_s: must be a number >= 0", "retry.jitter: unknown key"]),
    ("retry types", {"queue_name": "q", "printers": [P()], "retry": {"attempts": 2.0, "backoff_s": False}},
     ["retry.attempts: must be an integer between 0 and 10", "retry.backoff_s: must be a number >= 0"]),
    ("default printer with broken printers", {"queue_name": "q", "printers": {"name": "p"}, "default_printer": "p"},
     ["printers: must be a non-empty list"]),
    ("default printer matches", {"queue_name": "q", "printers": [P(name="x"), P(name="y", port=None)], "default_printer": "y"},
     ["printers[1].port: must be an integer between 1 and 65535"]),
]

p = run([sys.executable, "-c", DRIVER], stdin=json.dumps([c[1] for c in CASES]))
results = None
if p is None:
    fail("validate(): timed out")
else:
    for line in reversed(p.stdout.splitlines()):
        if line.startswith("@@RESULT@@"):
            results = json.loads(line[10:])
            break
    if results is None:
        fail("could not call validate(): %s" % p.stderr.strip()[-200:])
if results is not None:
    for (name, _cfg, want), got in zip(CASES, results):
        if got != sorted(want):
            fail("%s: validate returned %s, expected %s" % (name, json.dumps(got), json.dumps(sorted(want))))

with tempfile.TemporaryDirectory() as tmp:
    def cli(name, text):
        path = os.path.join(tmp, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path, run([sys.executable, "-m", "labelrelay", "check", path])

    path, p = cli("good.json", json.dumps(CASES[1][1]))
    if p is None or p.returncode != 0 or p.stdout.strip() != "ok":
        fail("check on a valid config: expected 'ok' and exit 0")
    path, p = cli("bad.json", json.dumps(CASES[7][1]))
    if p is None or p.returncode != 1:
        fail("check on an invalid config: expected exit 1")
    else:
        got = sorted(l.strip() for l in p.stderr.splitlines() if l.strip())
        if got != sorted(CASES[7][2]):
            fail("check on an invalid config: stderr lines %r, expected %r" % (got, sorted(CASES[7][2])))
    path, p = cli("broken.json", '{"queue_name": "q",')
    if p is None or p.returncode != 1 or "%s: invalid JSON" % path not in p.stderr:
        fail("check on malformed JSON: expected exit 1 and 'PATH: invalid JSON' on stderr")

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
