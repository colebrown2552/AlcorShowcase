import json, os, subprocess, sys, tempfile

FAILS = []

# Agent code runs with an explicit minimal environment: nothing inherited.
AGENT_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1"}


def fail(msg):
    FAILS.append(msg)


def run(args, timeout=20):
    try:
        return subprocess.run(args, cwd=os.getcwd(), capture_output=True, text=True, env=AGENT_ENV, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


V1_FULL = {"base_url": "/club/", "output_dir": "site-out", "minify": False, "minify_exclude": ["a.js", " ", " b/*.css "],
           "dev_host": "localhost", "dev_port": 5001, "plugins": " gallery, ,redirects ,", "analytics_id": "T-123",
           "theme": {"name": "harbour"}}
WANT_FULL = {"schema": 2, "site": {"base_url": "/club/"},
             "build": {"output": "site-out", "minify": {"enabled": False, "exclude": ["a.js", "b/*.css"]}},
             "serve": {"host": "localhost", "port": 5001}, "plugins": ["gallery", "redirects"],
             "legacy": {"analytics_id": "T-123", "theme": {"name": "harbour"}}}
V1_MIN = {"dev_port": "3000", "minify_exclude": ""}
WANT_MIN = {"schema": 2, "site": {"base_url": "/"},
            "build": {"output": "public", "minify": {"enabled": False, "exclude": []}},
            "serve": {"host": "127.0.0.1", "port": 3000}, "plugins": []}
V2_TEXT = '{"schema":2,   "build": {"output": "x"},\n\n "plugins": "not-touched"}'
V3_TEXT = '{"schema": 3, "build": {}}\n'
BAD_TEXT = '{"output_dir": "dist",'
LIST_TEXT = '["output_dir"]'

with tempfile.TemporaryDirectory() as tmp:
    paths = {}
    for name, text in [("full.json", json.dumps(V1_FULL)), ("min.json", json.dumps(V1_MIN)), ("v2.json", V2_TEXT),
                       ("v3.json", V3_TEXT), ("bad.json", BAD_TEXT), ("list.json", LIST_TEXT)]:
        paths[name] = os.path.join(tmp, name)
        with open(paths[name], "w", encoding="utf-8") as fh:
            fh.write(text)

    def read(name):
        with open(paths[name], encoding="utf-8") as fh:
            return fh.read()

    order = ["full.json", "v2.json", "bad.json", "min.json", "v3.json", "list.json"]
    p = run([sys.executable, "migrate_settings.py"] + [paths[n] for n in order])
    if p is None:
        fail("migration run timed out")
    else:
        if p.returncode != 1:
            fail("run with broken files: expected exit status 1, got %s" % p.returncode)
        out, err = p.stdout.splitlines(), p.stderr
        for name in ("full.json", "min.json"):
            if "migrated %s" % paths[name] not in out:
                fail("expected 'migrated %s' on stdout" % name)
        if "up to date %s" % paths["v2.json"] not in out:
            fail("expected 'up to date FILE' on stdout for a schema 2 file")
        if "error: %s: unsupported schema 3" % paths["v3.json"] not in err:
            fail("expected 'error: FILE: unsupported schema 3' on stderr")
        for name in ("bad.json", "list.json"):
            if "error: %s: not a settings file" % paths[name] not in err:
                fail("expected 'error: FILE: not a settings file' on stderr for %s" % name)
        for name, want in [("full.json", WANT_FULL), ("min.json", WANT_MIN)]:
            try:
                got = json.loads(read(name))
            except ValueError:
                fail("%s: migrated file is not valid JSON" % name)
                continue
            if got != want:
                fail("%s: migrated to %s, expected %s" % (name, json.dumps(got), json.dumps(want)))
        for name, text in [("v2.json", V2_TEXT), ("v3.json", V3_TEXT), ("bad.json", BAD_TEXT), ("list.json", LIST_TEXT)]:
            if read(name) != text:
                fail("%s should have been left byte-for-byte unchanged" % name)

    first = read("full.json")
    p = run([sys.executable, "migrate_settings.py", paths["full.json"]])
    if p is None or p.returncode != 0 or "up to date %s" % paths["full.json"] not in p.stdout:
        fail("second run on a migrated file: expected exit 0 and 'up to date FILE'")
    elif read("full.json") != first:
        fail("second run changed an already migrated file")

    p = run([sys.executable, "-c", "import sys; from sitebuild.settings import load_settings; "
             "s = load_settings(sys.argv[1]); print(s['serve']['port'])", paths["min.json"]])
    if p is None or p.returncode != 0 or p.stdout.strip() != "3000":
        fail("migrated file does not load with load_settings")

for m in FAILS[:8]:
    print("FAIL: " + m)
if FAILS:
    sys.exit(1)
print("PASS")
