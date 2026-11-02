"""AlcorBrowser end-to-end demo: offline, no browser, deterministic.

What runs for real: the broker (HTTP, MCP, tokens, receipts, upload tickets, the update verifier),
the native-messaging host, the installer's file copy, and the channel publisher.
What is pretend: the browser. ``fakes.py`` plays Chrome and the extension worker against a tiny
page model, so every command and result crosses the real attach protocol.

    python demo/run_demo.py

Exit code 0 means every check passed. Everything happens in a temporary folder that is removed at
the end; nothing outside it is read or written.
"""

import hashlib
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True  # keep the checkout clean: no __pycache__ beside the sources
sys.path.insert(0, str(ROOT / "runtime"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import companion  # noqa: E402
import install  # noqa: E402
import update_channel  # noqa: E402
from broker import Broker, token_file  # noqa: E402
from fakes import FakeBrowser, FakeChrome  # noqa: E402
from settings import load_settings  # noqa: E402

FAKE_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"  # the shape of a Chrome id, not a real one
TYPED_EMAIL = "demo-user"
TYPED_SECRET = "correct horse battery staple"  # what the agent tries to type into the password box

results: list[tuple[str, bool]] = []


def check(name: str, ok: object, detail: str = "") -> bool:
    """Record and print one check; a failing check is shown with its detail."""
    results.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  <- {detail}"))
    return bool(ok)


def heading(text: str) -> None:
    print(f"\n== {text}")


def http_post(port: int, path: str, body: object, headers: dict | None = None) -> tuple[int, dict]:
    """POST JSON to the broker and return (status, parsed body or None)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    conn.request(
        "POST",
        path,
        json.dumps(body).encode(),
        {"Content-Type": "application/json", **(headers or {})},
    )
    response = conn.getresponse()
    raw = response.read()
    conn.close()
    return response.status, (json.loads(raw) if raw else None)


def status_of(port: int, body: object, headers: dict | None = None) -> object:
    """POST to ``/mcp`` and return only the HTTP status, or the error name if the link dropped."""
    try:
        return http_post(port, "/mcp", body, headers)[0]
    except (OSError, http.client.HTTPException) as exc:
        return type(exc).__name__


class Agent:
    """A minimal MCP client: one agent, one bearer token."""

    def __init__(self, port: int, token: str) -> None:
        self.port, self.token, self.n = port, token, 0

    def rpc(self, method: str, params: dict | None = None) -> dict:
        self.n += 1
        body = {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}}
        return http_post(self.port, "/mcp", body, {"Authorization": f"Bearer {self.token}"})[1]

    def call(self, tool: str, **args: object) -> dict:
        """Call a tool; returns its JSON payload plus ``_is_error`` from the MCP envelope."""
        result = self.rpc("tools/call", {"name": tool, "arguments": args})["result"]
        return {**json.loads(result["content"][0]["text"]), "_is_error": result["isError"]}


def tree_digest(*folders: Path) -> str:
    """Hash every file under the given folders (path and bytes), to compare before and after."""
    digest = hashlib.sha256()
    for folder in folders:
        for path in sorted(p for p in folder.rglob("*") if p.is_file()):
            digest.update(path.relative_to(folder.parent).as_posix().encode() + b"\0")
            digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()


def receipts_of(home: Path) -> list[dict]:
    path = home / "state" / "agent-receipts.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def make_build(target: Path, version: str, marker: str, extra_file: str = "") -> Path:
    """Copy this repository's extension and runtime into ``target`` with a visible change."""
    shutil.copytree(ROOT / "extension", target / "extension")
    ignore = shutil.ignore_patterns("__pycache__")
    shutil.copytree(ROOT / "runtime", target / "runtime", ignore=ignore)
    manifest = target / "extension" / "manifest.json"
    text = manifest.read_text(encoding="utf-8")
    manifest.write_text(text.replace('"version": "2.2.1"', f'"version": "{version}"'), "utf-8")
    for rel, comment in (("extension/popup.js", "//"), ("runtime/companion.py", "#")):
        with (target / rel).open("a", encoding="utf-8") as handle:
            handle.write(f"\n{comment} demo build marker: {marker}\n")
    if extra_file:
        (target / "extension" / extra_file).write_text("// added by the build\n")
    return target


def read_install_config(extension_dir: Path) -> dict:
    """Parse the ``config.js`` the installer wrote, the way the extension worker reads it."""
    text = (extension_dir / "config.js").read_text(encoding="utf-8")
    return json.loads(text.split("=", 1)[1].strip().rstrip(";"))


@dataclass
class Demo:
    """Everything the steps share: the temporary home, the running broker and the fake browser."""

    home: Path
    channel_dir: Path
    outside: Path
    broker: Broker
    browser: FakeBrowser
    update_applied: threading.Event
    server: companion.BrokerServer
    port: int = 0
    chrome: FakeChrome | None = None
    tokens: dict | None = None

    @property
    def ext_dir(self) -> Path:
        return self.home / "extension-agents-demo"

    def installed(self) -> str:
        """A digest of the broker's runtime folder and the installed extension copy."""
        return tree_digest(self.home / "runtime", self.ext_dir)


def setup(tmp: Path) -> Demo:
    """Install into a temporary home, write the settings, and start the broker on a free port."""
    heading("1. Install into a temporary home, configure two agents and an upload folder")
    home, channel_dir, outside = tmp / "home", tmp / "channel", tmp / "outside"
    outside.mkdir()
    (outside / "private.txt").write_text("not for upload\n")
    build = install.install_tree(ROOT, home, "demo")
    (home / "uploads" / "hello.txt").write_text("hello from the allowed folder\n")
    settings = {
        "agents": ["agent-a", "agent-b"],
        "extension_id": FAKE_EXTENSION_ID,
        "upload_dirs": [str(home / "uploads")],
        "update_channel": str(channel_dir),
    }
    (home / "config.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")
    print(f"  installed extension build {build[:12]} into extension-agents-demo")
    update_applied = threading.Event()
    broker = Broker(
        home,
        settings=load_settings(home, {}),
        runtime_dir=home / "runtime",
        command_timeout_s=2.0,  # the real default is 60 s; short so the "hung page" step is quick
        exit_hook=update_applied.set,  # a real update ends the process; the demo must survive it
    )
    server = companion.make_server(broker, listen_port=0)
    kwargs = {"poll_interval": 0.1}
    threading.Thread(target=server.serve_forever, kwargs=kwargs, daemon=True).start()
    print("  broker listening on a free loopback port")
    browser = FakeBrowser(FAKE_EXTENSION_ID)
    demo = Demo(home, channel_dir, outside, broker, browser, update_applied, server)
    demo.port = broker.port
    demo.tokens = {n: token_file(home, n) for n in ("agent-a", "agent-b", "extension")}
    return demo


def attach(d: Demo) -> None:
    heading("2. The pretend browser attaches through the real native host")
    config = read_install_config(d.ext_dir)
    hello = {
        "type": "hello",
        "profile_label": config["profile_label"],
        "browser_session": "demo-session",
        "version": "2.2.1",
        "build": config["build"],
        "install_dir": config["install_dir"],
        "roles": ["agents"],
        "browser": "FakeChrome/1.0",
    }
    env = {**os.environ, "ALCOR_BROWSER_HOME": str(d.home), "ALCOR_BROWSER_PORT": str(d.port)}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    d.chrome = FakeChrome(ROOT / "runtime" / "native_host.py", env, d.browser, hello)
    welcome = d.chrome.wait_for_welcome()
    check("native host relayed hello -> welcome", welcome is not None)
    check(
        "installed build matches the running one (no reload asked)",
        (welcome or {}).get("reload") is False,
    )
    profiles = [b["profile"] for b in d.broker.admin_status()["browsers"]]
    check("broker lists one attached profile", profiles == ["demo"])


def authentication(d: Demo) -> None:
    heading("3. Authentication and the browser-origin guard")
    probe = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    good = {"Authorization": f"Bearer {d.tokens['agent-a']}"}
    check("no token -> 401", status_of(d.port, probe) == 401)
    check("wrong token -> 401", status_of(d.port, probe, {"Authorization": "Bearer nope"}) == 401)
    # A header may carry characters outside ASCII; the broker must answer, not drop the link.
    odd = {"Authorization": "Bearer caf" + chr(0xE9)}
    check(
        "non-ASCII token -> a clean 401, not a crashed handler",
        status_of(d.port, probe, odd) == 401,
    )
    web_page = {**good, "Origin": "https://example.com"}
    check(
        "a web page's request (it carries an Origin) -> 403",
        status_of(d.port, probe, web_page) == 403,
    )
    check("valid agent token -> 200", status_of(d.port, probe, good) == 200)
    relay = {"Authorization": f"Bearer {d.tokens['extension']}"}
    check("the native relay's token is not an agent token", status_of(d.port, probe, relay) == 401)


def agent_session(d: Demo) -> None:
    heading("4. An agent drives the browser over MCP")
    a, b = Agent(d.port, d.tokens["agent-a"]), Agent(d.port, d.tokens["agent-b"])
    info = a.rpc("initialize", {"protocolVersion": "2025-06-18"})["result"]
    print(f"  server: {info['serverInfo']['name']} {info['serverInfo']['version']}")
    tools = [t["name"] for t in a.rpc("tools/list")["result"]["tools"]]
    print(f"  tools/list: {len(tools)} tools, e.g. {', '.join(tools[:6])}, ...")
    wanted = {
        "browser_open",
        "browser_snapshot",
        "browser_type",
        "browser_upload",
        "browser_chatgpt",
    }
    check("tools/list exposes the browser tools", wanted <= set(tools))

    opened = a.call("browser_open", url="https://example.com/login")
    print(f"  browser_open -> tab {opened.get('tab')} ({opened.get('title')})")
    check("browser_open names the tab with a short handle", opened.get("tab") == "t1")
    snap = a.call("browser_snapshot", tab="t1")
    elements = snap.get("elements", "")
    for line in elements.splitlines():
        print(f"    {line}")
    check("the snapshot flags the password field", 'textbox "Password" password' in elements)

    print("  (the password rule lives in extension/page.js; the fake page re-implements it)")
    sid = snap.get("snapshot_id")
    typed = a.call("browser_type", tab="t1", ref="e2", snapshot_id=sid, text=TYPED_EMAIL)
    check("typing into the email box works", typed.get("value") == TYPED_EMAIL)
    refused = a.call("browser_type", tab="t1", ref="e3", snapshot_id=sid, text=TYPED_SECRET)
    print(f"  browser_type -> password field: {refused}")
    check(
        "typing into the password box is refused and is an MCP error",
        refused.get("refused") == "password-field" and refused["_is_error"] is True,
    )
    check("the fake page's password box stayed empty", d.browser.pages[101].elements[2].value == "")
    stale = a.call("browser_click", tab="t1", ref="e4", snapshot_id="not-the-snapshot")
    check(
        "a ref from another snapshot is refused as stale",
        "stale-snapshot" in str(stale.get("error")),
    )
    seen = b.call("browser_tabs")
    check(
        "a second agent sees the same tab handle",
        [t["tab"] for t in seen.get("tabs", [])] == ["t1"],
    )


def uploads(d: Demo) -> None:
    heading("5. Uploads: allowlist, one-time tickets, browser-origin guard")
    a = Agent(d.port, d.tokens["agent-a"])
    inside = str(d.home / "uploads" / "hello.txt")
    outside = str(d.outside / "private.txt")
    climbing = str(d.home / "uploads" / ".." / ".." / "outside" / "private.txt")
    expect = {
        "a file outside the allowed folder is refused": (outside, "upload-path-not-allowed"),
        "a ../ path that climbs out of the allowed folder is refused": (
            climbing,
            "upload-path-not-allowed",
        ),
        "a missing file inside the allowed folder says so": (
            inside + ".missing",
            "upload-file-missing",
        ),
    }
    for name, (path, code) in expect.items():
        check(name, a.call("browser_upload", tab="t1", path=path).get("error") == code)
    sent = a.call("browser_upload", tab="t1", path=inside)
    fetched = d.browser.uploaded[-1]["name"] if d.browser.uploaded else None
    check(
        "a file in the allowed folder uploads; the extension fetched it by ticket",
        sent.get("ok") is True and fetched == "hello.txt",
    )

    command = next(c for c in reversed(d.chrome.commands) if c["op"] == "upload")
    ticket_path = urlparse(command["args"]["ticket_url"]).path

    def fetch_ticket(headers: dict) -> int:
        conn = http.client.HTTPConnection("127.0.0.1", d.port, timeout=10)
        conn.request("GET", ticket_path, headers=headers)
        code = conn.getresponse().status
        conn.close()
        return code

    check("the same ticket cannot be used twice", fetch_ticket({}) == 404)
    check(
        "a web page cannot use a ticket (foreign Origin -> 403)",
        fetch_ticket({"Origin": "https://example.com"}) == 403,
    )


def uncertain(d: Demo) -> None:
    heading("6. A command that gets no answer is reported as uncertain and never replayed")
    hung = Agent(d.port, d.tokens["agent-a"]).call("browser_open", url="https://example.com/slow")
    print(f"  browser_open (the page hangs) -> {hung}")
    time.sleep(1.5)  # long enough for a replay to show up
    sent = [
        c for c in d.chrome.commands if c["op"] == "open" and c["args"]["url"].endswith("/slow")
    ]
    check(
        "the timeout is reported as uncertain",
        hung.get("error") == "browser-timeout" and hung.get("uncertain"),
    )
    check("the broker sent that command exactly once", len(sent) == 1)


def hub_and_receipts(d: Demo) -> None:
    heading("7. The popup's view (hub) and the receipts")
    hub = d.chrome.hub("status")
    print(
        f"  hub status: broker {hub.get('broker_version')}, {hub.get('tabs_named')} tab(s) named, "
        f"update source: {hub.get('channel_kind')}"
    )
    recent = [r.get("tool") for r in hub.get("recent", [])]
    check("the hub lists recent agent calls, newest last", recent[-1:] == ["browser_open"])
    rows = [r for r in receipts_of(d.home) if r.get("tool")]
    for r in rows:
        call = f"{r['agent']} {r['tool']:<17} tab={r['tab'] or '-':<3}"
        page = f"origin={r['origin'] or '-':<20}"
        outcome = f"ok={str(r['ok']):<5} err={r['error'] or '-':<24}"
        print(f"    {call} {page} {outcome} text_len={r['text_len']}")
    raw = (d.home / "state" / "agent-receipts.jsonl").read_text(encoding="utf-8")
    typed = next((r for r in rows if r["tool"] == "browser_type" and r["ok"]), {})
    digest = hashlib.sha256(TYPED_EMAIL.encode()).hexdigest()[:16]
    check(
        "a receipt keeps the length and a short hash of typed text",
        typed.get("text_len") == len(TYPED_EMAIL) and typed.get("text_sha256") == digest,
    )
    check(
        "receipts never contain typed text or page text",
        not any(s in raw for s in (TYPED_EMAIL, TYPED_SECRET, "Sign in to continue")),
    )
    check(
        "receipts keep the origin, not the path",
        "https://example.com" in raw and "/login" not in raw,
    )
    everything = raw + json.dumps(d.broker.admin_status())
    check(
        "receipts and status never contain a token",
        not any(t in everything for t in d.tokens.values()),
    )


def update_applies(d: Demo, tmp: Path) -> None:
    heading("8. Update channel: publish, verify, apply")
    build_b = make_build(tmp / "src-b", "2.2.2", "build B")
    manifest = update_channel.publish(build_b, d.channel_dir, ["demo build B"])
    print(f"  published version {manifest.version}, build {manifest.build[:12]}, ", end="")
    print(f"{len(manifest.files)} files")
    before, config_before = d.installed(), read_install_config(d.ext_dir)
    outcome = d.broker.updater.check("demo")
    print(f"  check -> {outcome}")
    check(
        "a verified newer build is applied",
        outcome == {"ok": True, "applied": True, "to": manifest.build[:12]},
    )
    installed = {"runtime": d.home / "runtime", "extension": d.ext_dir}
    check(
        "every installed file now matches the manifest",
        all(
            update_channel.sha256_file(installed[f.kind] / f.name) == f.sha256
            for f in manifest.files
        ),
    )
    check("the install changed", d.installed() != before)
    config_after = read_install_config(d.ext_dir)
    check(
        "config.js got the new build id and kept its other fields",
        config_after == {**config_before, "build": manifest.build},
    )
    reloaded = any(c["op"] == "reload" for c in d.chrome.commands)
    check(
        "the extension was told to reload, then the broker asked to exit",
        d.update_applied.wait(10) and reloaded,
    )
    events = [r["event"] for r in receipts_of(d.home) if r.get("event", "").startswith("update-")]
    print(f"  receipts: {', '.join(events)}")
    check(
        "receipts record start, staged, applied and the reload",
        events[-4:] == ["update-start", "update-staged", "update-applied", "update-reload"],
    )


def update_tampered(d: Demo, tmp: Path) -> None:
    heading("9. Tamper with one published file: refused before anything is touched")
    update_channel.publish(
        make_build(tmp / "src-c", "2.2.3", "build C"), d.channel_dir, ["build C"]
    )
    victim = d.channel_dir / "extension" / "popup.js"
    flipped = bytearray(victim.read_bytes())
    flipped[10] ^= 0x01  # one bit, same size: only the hash can catch it
    victim.write_bytes(bytes(flipped))
    before = d.installed()
    d.update_applied.clear()
    outcome = d.broker.updater.check("demo")
    print(f"  check -> {outcome}")
    failures = [r for r in receipts_of(d.home) if r.get("event") == "update-failed"]
    check(
        "the tampered file is refused at verification",
        outcome == {"ok": False, "failed": "verify"}
        and failures[-1:]
        and failures[-1].get("path") == "extension/popup.js",
    )
    check("nothing was installed: the tree is byte-identical", d.installed() == before)
    check("the scratch folder was cleaned up", not (d.home / "state" / "update-stage").exists())
    again = d.broker.updater.check("timer")
    check(
        "the timer does not hammer a build that just failed",
        again == {"ok": False, "needed": True, "skipped": "recent-failure"},
    )


def update_hostile_manifest(d: Demo) -> None:
    heading("10. A hostile manifest is refused before any file is fetched")
    manifest = json.loads((d.channel_dir / "version.json").read_text(encoding="utf-8"))
    climbing = {"path": "extension/../evil.py", "sha256": "0" * 64, "size": 1}
    hostile = {
        "a build id that would be spliced into config.js": {
            **manifest,
            "build": 'ab"};fetch("//elsewhere");//' + "0" * 12,
        },
        "a file path that climbs out of its folder": {
            **manifest,
            "files": [*manifest["files"], climbing],
        },
        "a manifest that drops the extension's own manifest.json": {
            **manifest,
            "files": [f for f in manifest["files"] if f["path"] != "extension/manifest.json"],
        },
    }
    before = d.installed()
    for name, document in hostile.items():
        (d.channel_dir / "version.json").write_text(json.dumps(document), encoding="utf-8")
        outcome = d.broker.updater.check("demo")
        check(
            f"refused: {name}",
            outcome.get("failed") == "manifest" and d.installed() == before,
            str(outcome),
        )


def update_rolls_back(d: Demo, tmp: Path) -> None:
    heading("11. A failure while replacing files rolls everything back")
    build_d = make_build(tmp / "src-d", "2.2.4", "build D", extra_file="extra.js")
    update_channel.publish(build_d, d.channel_dir, ["build D"])
    (d.ext_dir / "extra.js").mkdir()  # a folder where the update wants to write a file
    before = d.installed()
    outcome = d.broker.updater.check("demo")
    print(f"  check -> {outcome}")
    events = [(r.get("event"), r.get("ok")) for r in receipts_of(d.home)]
    check("the apply step failed", outcome == {"ok": False, "failed": "apply"})
    check("the backup was restored", ("update-restored", True) in events)
    check("the tree is byte-identical to before the attempt", d.installed() == before)
    check("the exit hook was not called for a failed update", not d.update_applied.is_set())


def main() -> int:
    print("AlcorBrowser demo: real broker, real native host, pretend browser")
    with tempfile.TemporaryDirectory(
        prefix="alcorbrowser-demo-", ignore_cleanup_errors=True
    ) as name:
        tmp = Path(name)
        d = setup(tmp)
        try:
            attach(d)
            authentication(d)
            agent_session(d)
            uploads(d)
            uncertain(d)
            hub_and_receipts(d)
            update_applies(d, tmp)
            update_tampered(d, tmp)
            update_hostile_manifest(d)
            update_rolls_back(d, tmp)
        finally:
            if d.chrome is not None:
                d.chrome.close()
            d.server.shutdown()
            d.server.server_close()

    passed = sum(ok for _, ok in results)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        print("FAILED: " + "; ".join(name for name, ok in results if not ok))
        return 1
    print("What this proved: agents authenticate per name; a browser page cannot reach the broker;")
    print("tools cross the real native-messaging path; the password floor's refusal travels back;")
    print("receipts hold hashes and origins, never text; uploads obey an allowlist and one-time")
    print("tickets; a timeout is 'uncertain' and never replayed; updates are verified, staged,")
    print("backed up and rolled back on failure. What it did not prove: the extension's JavaScript")
    print("in a real Chrome (see README, Scope and limits).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
