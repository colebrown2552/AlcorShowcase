"""End-to-end demo of the release pipeline: offline, on loopback, deterministic.

What really runs: the `python -m sitekit` command line, the host-side controller as a separate
process, the contract suites as separate processes, and two directory hosts ("staging" and
"production") each behind a loopback web server. What is stood in: the hosts themselves
(sitekit.mock_transport) and the cold-read model (a keyword stand-in). Nothing leaves 127.0.0.1
and no browser or language model is used.

The walk-through:
  land -> contract -> cold read -> promote refused three ways (no code, stale receipt, hold) ->
  promote with a fresh code -> the same code refused a second time -> rollback with no code ->
  a failing contract blocks promotion -> restore the pre-controller site -> tampered audit log.

Usage:  python demo/run_demo.py [--keep]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

CODE_LINE = re.compile(r"^[0-9A-Z]{4}(?:-[0-9A-Z]{4}){3}$")
STAMP = re.compile(r"\d{8}T\d{6}Z")
EARLY = "Sourdough sells out by noon, so come early."


class DemoFailure(Exception):
    """A claim the demo makes did not hold."""


@dataclass
class World:
    """Everything the scenario touches: the two hosts, the site versions and the state folders."""

    staging: object
    production: object
    versions: dict
    home: Path
    repo: Path
    controller: Path


class Demo:
    """Runs the CLI against the hosts and checks what each step must have done."""

    def __init__(self, work: Path) -> None:
        self.work = work
        self.proved = 0
        self.env = {
            **{k: v for k, v in os.environ.items() if not k.startswith("SITEKIT_")},
            "SITEKIT_HOME": str(work / "home"),
            "SITEKIT_CONFIG": str(work / "config.json"),
            "PYTHONPATH": str(ROOT),
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def scrub(self, text: str) -> str:
        """Hide per-run details (ports, timestamps, the temp folder) from the printed output."""
        text = text.replace(str(self.work), "<work>")
        text = re.sub(r"[A-Za-z]:[\\/][^\s'\"]*sitekit-demo-\w+", "<work>", text)
        text = re.sub(r"127\.0\.0\.1:\d+", "127.0.0.1:<port>", text)
        return STAMP.sub("<time>", text)

    def run(
        self, *args: str, show: int = 12, secret: str | None = None, quiet: bool = False
    ) -> tuple[int, str]:
        """Run `sitekit ARGS`; print the command and its output; return the exit code and output.

        Output longer than `show` lines keeps its beginning and its end, because the verdict is
        usually the last line. `secret` is a value in ARGS that must never be printed (an
        approval code); `quiet` suppresses the output as well, for the one command whose output
        is the secrets.
        """
        done = subprocess.run(
            [sys.executable, "-m", "sitekit", *args],
            cwd=ROOT,
            env=self.env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            check=False,
        )
        shown = " ".join("<code>" if secret and a == secret else a for a in args)
        print(f"\n  $ sitekit {self.scrub(shown)}")
        out = self.scrub(done.stdout + done.stderr)
        lines = [line for line in out.splitlines() if line.strip()]
        if quiet:
            print("      (output not shown)")
        else:
            if len(lines) > show:
                hidden = len(lines) - show
                lines = [
                    *lines[: show // 2],
                    f"... ({hidden} lines not shown)",
                    *lines[-(show - show // 2) :],
                ]
            for line in lines:
                print(f"      {line[:120]}")
        return done.returncode, done.stdout + done.stderr

    def prove(self, claim: str, condition: bool) -> None:
        """Print a claim as proved, or stop the demo if it does not hold."""
        if not condition:
            raise DemoFailure(claim)
        self.proved += 1
        print(f"  [proved] {claim}")

    def remaining(self) -> int:
        """How many approval codes are unused, asked of the real CLI."""
        done = subprocess.run(
            [sys.executable, "-m", "sitekit", "approve", "--remaining"],
            cwd=ROOT,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )
        return int(done.stdout.strip())


def copy_site(dest: Path) -> None:
    """Copy demo/site to `dest` with LF line endings, so commit ids match on every platform."""
    for source in sorted((HERE / "site").rglob("*")):
        if source.is_file():
            target = dest / source.relative_to(HERE / "site")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes().replace(b"\r\n", b"\n"))


def edit(path: Path, old: str, new: str) -> None:
    """Replace text in a file, failing loudly if the text is not there."""
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise DemoFailure(f"demo edit did not apply to {path.name}")
    path.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


def build_versions(root: Path) -> dict:
    """Make three versions of the site: 1 is the base, 2 adds a sentence, 3 breaks two things."""
    versions = {name: root / name for name in ("v1", "v2", "v3")}
    for path in versions.values():
        copy_site(path)
    for name in ("v2", "v3"):
        order = "Order a cake by phone or visit the shop."
        edit(versions[name] / "index.html", order, f"{order} {EARLY}")
    # Release 3 loses the menu's only h1 and links to a page that does not exist.
    edit(versions["v3"] / "menu" / "index.html", "<h1>Menu</h1>", "<h2>Menu</h2>")
    contact = versions["v3"] / "contact" / "index.html"
    edit(contact, "</main>", '<p><a href="/hours/">Opening hours</a></p></main>')
    return versions


def heading(number: int, title: str) -> None:
    """Print a step heading."""
    print(f"\n== {number}. {title}")


def wait_for(check, seconds: float = 15.0) -> bool:
    """Poll `check()` until it is true or the time runs out."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.1)
    return False


def scenario(demo: Demo, world: World) -> None:
    """The walk-through itself. Each `prove` is a claim the pipeline must back up."""
    from sitekit.net import controller_status, fetch, served_commit
    from sitekit.repo import ReleaseRepo

    staging, production = world.staging, world.production
    repo = ReleaseRepo(world.repo)
    legacy = production.public_digest()

    def page(host: object, path: str) -> str:
        return fetch(host.url + path)[1].decode("utf-8", errors="replace")

    heading(0, "Set up: the approver mints one-time codes")
    rc, out = demo.run("approve", "--count", "3", quiet=True)
    codes = [line.strip() for line in out.splitlines() if CODE_LINE.match(line.strip())]
    demo.prove("three one-time codes were minted and shown once", rc == 0 and len(codes) == 3)
    stored = (world.controller / "approval-codes").read_text(encoding="utf-8")
    demo.prove(
        "only hashes are stored: no code appears in the approval file",
        all(code.replace("-", "") not in stored.replace("-", "") for code in codes),
    )
    code_a, code_b, code_c = codes

    heading(1, "Land release 1 on staging")
    rc, out = demo.run("land", str(world.versions["v1"]))
    commit_1 = served_commit(staging.url)
    demo.prove(
        "staging serves release 1; the served-files gate passed", rc == 0 and "LANDED" in out
    )
    demo.prove("production was not touched by a staging land", production.public_digest() == legacy)
    rc, out = demo.run("land", str(world.versions["v1"]))
    demo.prove("landing identical content again is refused", rc == 8 and "NOTHING_TO_LAND" in out)

    heading(2, "Promotion needs a contract run first")
    rc, out = demo.run("promote")
    demo.prove(
        "promote says not ready: there is no contract receipt yet", rc == 1 and "TODO" in out
    )

    heading(3, "Run the contract against staging")
    rc, out = demo.run("contract")
    demo.prove("the contract is GREEN for release 1", rc == 0 and "contract GREEN" in out)

    heading(4, "Cold read and review (advisory; offline keyword stand-in, no model)")
    rc, out = demo.run("coldread", "--personas", "1")
    demo.prove("cold read ran end to end and wrote a report", rc == 0 and "REPORT.md" in out)
    rc, out = demo.run("review")
    demo.prove("review flags the contact page, which never says what is sold", "/contact/" in out)

    heading(5, "Promote is refused without an approval code and id")
    rc, out = demo.run("promote", "--go")
    demo.prove(
        "no code: refused (approval-code-missing)", rc == 1 and "approval-code-missing" in out
    )
    rc, out = demo.run("promote", "--go", "--code", code_a, secret=code_a)
    demo.prove(
        "code, no approval id: refused (approval-id-missing)",
        rc == 1 and "approval-id-missing" in out,
    )
    demo.prove(
        "nothing was written: the pointer log is empty and production is unchanged",
        repo.pointer_entries() == [] and production.public_digest() == legacy,
    )

    heading(6, "A hold file freezes releases, even with a valid code")
    hold = world.home / "PROMOTE_HOLD"
    hold.write_text("change freeze for the demo\n", encoding="utf-8")
    args = ("promote", "--go", "--approved", "APPR-0001", "--code", code_a)
    rc, out = demo.run(*args, secret=code_a)
    demo.prove(
        "refused (on-hold) and the reason is shown",
        rc == 1 and "on-hold" in out and "change freeze" in out,
    )
    demo.prove("the refused code was not consumed: 3 unused", demo.remaining() == 3)
    hold.unlink()

    heading(7, "Promote with a fresh code")
    rc, out = demo.run(*args, secret=code_a)
    demo.prove(
        "production now serves release 1", rc == 0 and served_commit(production.url) == commit_1
    )
    demo.prove(
        "the legacy page is gone and release 1's pages are live",
        "Legacy site" not in page(production, "/")
        and "Menu - Northgate" in page(production, "/menu/"),
    )
    demo.prove("unrelated host data survived the deploy", production.protected_intact())
    demo.prove("the code was burned: 2 unused", demo.remaining() == 2)

    heading(8, "Release 2 lands; a stale receipt blocks promotion")
    rc, out = demo.run("land", str(world.versions["v2"]))
    commit_2 = served_commit(staging.url)
    demo.prove("staging serves release 2", rc == 0 and commit_2 != commit_1)
    live = production.public_digest()
    args_b = ("promote", "--go", "--approved", "APPR-0002", "--code", code_b)
    rc, out = demo.run(*args_b, secret=code_b)
    demo.prove(
        "refused (not-ready): the receipt is for release 1, not release 2",
        rc == 1 and "not-ready" in out and "receipt is for" in out,
    )
    demo.prove(
        "production unchanged, code unspent",
        production.public_digest() == live and demo.remaining() == 2,
    )

    heading(9, "A used code cannot be used twice")
    rc, out = demo.run("contract")
    demo.prove("the contract is GREEN for release 2", rc == 0)
    args_reuse = ("promote", "--go", "--approved", "APPR-0002", "--code", code_a)
    rc, out = demo.run(*args_reuse, secret=code_a)
    demo.prove("the controller refused the reused code", rc == 1 and "controller refused" in out)
    demo.prove(
        "production still serves release 1, byte for byte",
        served_commit(production.url) == commit_1 and production.public_digest() == live,
    )

    heading(10, "A fresh code ships release 2 (a refusal does not wedge it)")
    rc, out = demo.run(*args_b, secret=code_b)
    demo.prove(
        "production now serves release 2", rc == 0 and served_commit(production.url) == commit_2
    )
    demo.prove("one code left", demo.remaining() == 1)

    heading(11, "Roll back: no code is needed for a release that was live before")
    rc, out = demo.run("rollback", "--why", "demo")
    demo.prove(
        "production serves release 1 again", rc == 0 and served_commit(production.url) == commit_1
    )
    demo.prove("the rollback spent no code", demo.remaining() == 1)

    heading(12, "A failing contract blocks promotion")
    rc, out = demo.run("land", str(world.versions["v3"]))
    commit_3 = served_commit(staging.url)
    demo.prove(
        "release 3 is on staging (the landing gate only checks bytes)",
        rc == 0 and commit_3 not in (commit_1, commit_2),
    )
    rc, out = demo.run("contract")
    demo.prove(
        "the contract is RED: it found the missing h1 and the dead link",
        rc == 1 and "contract RED" in out,
    )
    live = production.public_digest()
    args_c = ("promote", "--go", "--approved", "APPR-0003", "--code", code_c)
    rc, out = demo.run(*args_c, secret=code_c)
    demo.prove(
        "refused (not-ready) with the failing contract as the reason",
        rc == 1 and "not-ready" in out and "contract is GREEN" in out,
    )
    demo.prove(
        "production unchanged, fresh code unspent",
        production.public_digest() == live and demo.remaining() == 1,
    )

    heading(13, "Emergency undo: the site as it was before the controller")
    rc, out = demo.run("rollback", "--to", "initial", "--why", "demo")
    restored = served_commit(production.url) == "" and "Legacy site" in page(production, "/")
    demo.prove("the pre-controller site is back and names no release", rc == 0 and restored)
    demo.prove(
        "production is byte-identical to how the demo found it",
        production.public_digest() == legacy,
    )
    demo.prove(
        "host data intact on both hosts, and still no code spent",
        production.protected_intact() and staging.protected_intact() and demo.remaining() == 1,
    )

    heading(14, "The audit log is tamper-evident")
    rc, out = demo.run("status")
    demo.prove("the pointer log verifies", "chain verified" in out)
    log = world.repo / "pointer.jsonl"
    original = log.read_text(encoding="utf-8")

    def controller_says(state: str) -> bool:
        return wait_for(lambda: controller_status(production.url).get("state") == state)

    # An edit to an old entry breaks the line after it, which names the old line's hash.
    older = original.replace("Promoted by sitekit", "Promoted by someone", 1)
    log.write_text(older, encoding="utf-8", newline="\n")
    rejected = controller_says("log-rejected")
    rc, out = demo.run("status")
    demo.prove("editing an old entry is detected by the operator", "BROKEN" in out)
    demo.prove("and by the controller, which acts on none of it", rejected)
    rc, out = demo.run("rollback", "--to", "initial")
    demo.prove("nothing can be appended to a broken log", rc == 1 and "pointer log breaks" in out)
    log.write_text(original, encoding="utf-8", newline="\n")
    demo.prove("with the log restored the controller accepts it again", controller_says("idle"))

    # Nothing commits to the newest line, so the chain alone cannot see an edit to it. The
    # controller remembers the last entry it acted on, and that anchor does.
    head, _, tail = original.rpartition("Rollback by sitekit: demo")
    log.write_text(head + "Rollback by sitekit: demx" + tail, encoding="utf-8", newline="\n")
    rejected = controller_says("log-rejected")
    rc, out = demo.run("status")
    demo.prove(
        "the operator's chain check cannot see an edit to the newest entry", "chain verified" in out
    )
    demo.prove("the controller's anchor does, and rejects the log", rejected)
    log.write_text(original, encoding="utf-8", newline="\n")
    demo.prove("restored, it carries on", controller_says("idle"))


def main() -> int:
    """Build the hosts and the site versions, run the scenario, always clean up."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--keep", action="store_true", help="keep the temporary folder")
    args = parser.parse_args()

    from sitekit.mock_transport import MockHost

    work = Path(tempfile.mkdtemp(prefix="sitekit-demo-"))
    hosts = {name: MockHost(work / "hosts" / name) for name in ("staging", "production")}
    controller = None
    log = None
    started = time.monotonic()
    try:
        for host in hosts.values():
            host.seed()
            host.start()
        world = World(
            staging=hosts["staging"],
            production=hosts["production"],
            versions=build_versions(work / "src"),
            home=work / "home",
            repo=work / "repo",
            controller=work / "controller",
        )
        world.home.mkdir()
        config = {
            "staging_url": world.staging.url,
            "production_url": world.production.url,
            "staging_dir": str(world.staging.root),
            "production_dir": str(world.production.root),
            "repo_dir": str(world.repo),
            "controller_dir": str(world.controller),
            "intended_file": str(HERE / "intended.json"),
            "smoke_pages": ["/", "/menu/"],
            "poll_seconds": 0.2,
            "wait_seconds": 60,
        }
        (work / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
        demo = Demo(work)
        print("sitekit demo: offline, loopback only. Each step prints the real CLI's output.")
        log = (work / "controller.log").open("w", encoding="utf-8")
        controller = subprocess.Popen(
            [sys.executable, "-m", "sitekit", "controller", "run", "--watch", "--interval", "0.2"],
            cwd=ROOT,
            env=demo.env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        scenario(demo, world)
        decided = re.compile(r"^controller: (live|needs-approval|failed-restored)( |$)")
        print("\nThe host side, as the controller logged its decisions:")
        for line in (work / "controller.log").read_text(encoding="utf-8").splitlines():
            if decided.match(line):
                print(f"  {demo.scrub(line)}")
        print(f"\nAll {demo.proved} claims proved in {time.monotonic() - started:.1f}s.")
        return 0
    except DemoFailure as failure:
        print(f"\nDEMO FAILED: {failure}", file=sys.stderr)
        return 1
    finally:
        if controller is not None:
            controller.terminate()
            try:
                controller.wait(timeout=10)
            except subprocess.TimeoutExpired:
                controller.kill()
        if log is not None:
            log.close()
        for host in hosts.values():
            host.stop()
        if args.keep:
            print(f"kept the demo state in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
