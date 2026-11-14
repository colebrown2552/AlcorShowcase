import json, os, subprocess, sys, tempfile

FAILS = []

# Agent code runs with an explicit minimal environment: nothing inherited.
AGENT_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"}


def fail(msg):
    FAILS.append(msg)


DRIVER = r'''
import json, sys
from shoebox.config import ConfigError, load_config
cases = json.loads(sys.stdin.read())
out = []
for case in cases:
    try:
        if case["environ"] is None:
            res = {"ok": load_config(case["path"])}
        else:
            res = {"ok": load_config(case["path"], environ=case["environ"])}
    except ConfigError as exc:
        res = {"error": str(exc)}
    except Exception as exc:
        res = {"other": "%s: %s" % (type(exc).__name__, exc)}
    out.append(res)
print("@@RESULT@@" + json.dumps(out))
'''


def call(cases, env):
    try:
        p = subprocess.run([sys.executable, "-c", DRIVER], cwd=os.getcwd(), input=json.dumps(cases),
                           capture_output=True, text=True, timeout=20, env=env)
    except subprocess.TimeoutExpired:
        return None, "timed out"
    for line in reversed(p.stdout.splitlines()):
        if line.startswith("@@RESULT@@"):
            return json.loads(line[10:]), None
    return None, "exit %s: %s" % (p.returncode, p.stderr.strip()[-200:])


BASE = {"source_dir": "~/Pictures", "target_url": "", "interval_minutes": 60, "compress": True,
        "max_upload_mbps": 0.0, "exclude": []}
FILE = {"source_dir": "/data/cam", "target_url": "", "interval_minutes": 45, "compress": False,
        "max_upload_mbps": 2.5, "exclude": ["a"]}


def merged(base, **kw):
    d = dict(base)
    d.update(kw)
    return d


with tempfile.TemporaryDirectory() as tmp:
    ini = os.path.join(tmp, "box.ini")
    with open(ini, "w", encoding="utf-8") as fh:
        fh.write("[shoebox]\nsource_dir = /data/cam\ninterval_minutes = 45\ncompress = Off\nmax_upload_mbps = 2.5\nexclude = a\n")
    cases = [
        ("file only", ini, {}, {"ok": FILE}),
        ("env over file", ini, {"SHOEBOX_INTERVAL_MINUTES": " 15 ", "SHOEBOX_COMPRESS": "YES", "SHOEBOX_EXCLUDE": "*.tmp, ,raw/,",
                                "SHOEBOX_MAX_UPLOAD_MBPS": "0.75", "SHOEBOX_TARGET_URL": "s3://bucket/x", "SHOEBOX_COLOR": "red",
                                "PATH_UNRELATED": "1"},
         {"ok": merged(FILE, interval_minutes=15, compress=True, exclude=["*.tmp", "raw/"], max_upload_mbps=0.75,
                       target_url="s3://bucket/x")}),
        ("env without file", None, {"SHOEBOX_COMPRESS": "0", "SHOEBOX_SOURCE_DIR": " /mnt/p "},
         {"ok": merged(BASE, compress=False, source_dir=" /mnt/p ")}),
        ("bool words", None, {"SHOEBOX_COMPRESS": " off "}, {"ok": merged(BASE, compress=False)}),
        ("bool on", ini, {"SHOEBOX_COMPRESS": "On"}, {"ok": merged(FILE, compress=True)}),
        ("empty value ignored", ini, {"SHOEBOX_INTERVAL_MINUTES": "", "SHOEBOX_SOURCE_DIR": ""}, {"ok": FILE}),
        ("bad int", ini, {"SHOEBOX_INTERVAL_MINUTES": "1.5"}, {"error": "SHOEBOX_INTERVAL_MINUTES: expected integer, got '1.5'"}),
        ("bad bool", None, {"SHOEBOX_COMPRESS": "maybe"}, {"error": "SHOEBOX_COMPRESS: expected boolean, got 'maybe'"}),
        ("bad float", None, {"SHOEBOX_MAX_UPLOAD_MBPS": "fast"}, {"error": "SHOEBOX_MAX_UPLOAD_MBPS: expected number, got 'fast'"}),
    ]
    payload = [{"path": c[1], "environ": c[2]} for c in cases]
    payload.append({"path": ini, "environ": None})
    env = dict(AGENT_ENV)
    env["SHOEBOX_EXCLUDE"] = "x,y"
    env["SHOEBOX_INTERVAL_MINUTES"] = "5"
    results, err = call(payload, env)
    if results is None:
        fail("could not call load_config: %s" % err)
    else:
        for (name, _p, _e, want), got in zip(cases, results):
            if got != want:
                fail("%s: got %s, expected %s" % (name, json.dumps(got), json.dumps(want)))
        want = {"ok": merged(FILE, exclude=["x", "y"], interval_minutes=5)}
        if results[-1] != want:
            fail("environ=None should read os.environ: got %s, expected %s" % (json.dumps(results[-1]), json.dumps(want)))

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
