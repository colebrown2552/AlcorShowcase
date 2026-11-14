"""CI gate: repo hygiene, then the CLI end to end. Exit 0 when everything holds.

1. Every Python file imports only the standard library (or its own task's modules).
2. No file carries a local home path or something that looks like a credential. Run
   metadata under results/ names no host other than a loopback one; transcripts, which
   hold task data and whatever the model typed, name no private address and not this machine.
3. `selfcheck` passes (statistics, sandbox, every task validated, scripted demo).
4. The CLI runs the scripted demo, reports, compares and resumes it (a no-op
   on a complete run), and refuses to write a demo run under results/.
"""

from __future__ import annotations

import ast
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRET_RE = re.compile(r"/home/[a-z]|/Users/[A-Za-z]|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}"
                       r"|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY")
SKIP_DIRS = {".git", "__pycache__"}
# Saved results may name only these hosts (the runner writes "local" or "redacted").
URL_HOST_RE = re.compile(r"[a-z][a-z0-9+.-]*://([^/:\s\"'\]\[]+)", re.IGNORECASE)
IPV4_RE = re.compile(r"(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])")
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "local", "redacted"}
# Transcripts legitimately carry example hosts and addresses from task data, addresses the
# model makes up, and a made-up home directory it types. What must never be in them is this
# machine: its name, one of its own addresses, an overlay-network (shared address space)
# address that no task contains, or a private host name.
OVERLAY_IP_RE = re.compile(r"(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}(?![\d.])")
PRIVATE_HOST_RE = re.compile(r"[a-z0-9-]+\.(?:ts\.net|internal|home\.arpa)\b", re.IGNORECASE)
PLACEHOLDER_HOME = "/home/" + "user"


def files() -> list[Path]:
    return [p for p in ROOT.rglob("*")
            if p.is_file() and not SKIP_DIRS.intersection(p.relative_to(ROOT).parts)]


def local_names(path: Path) -> set[str]:
    """Module names a file may import besides the stdlib.

    Inside a task (fixture, reference, mutants, check) that is the task's own
    top-level modules; elsewhere it is the alcorbench package.
    """
    task_dir = next((d for d in path.parents if (d / "task.json").is_file()), None)
    if task_dir is None:
        return {"alcorbench"}
    return {p.stem for sub in ("fixture", "reference") for p in (task_dir / sub).glob("*")}


def check_imports() -> list[str]:
    problems = []
    for path in files():
        if path.suffix != ".py":
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as exc:
            if "fixture" in path.parts:  # a fixture may be broken on purpose
                continue
            problems.append(f"{path.relative_to(ROOT)}: syntax error {exc}")
            continue
        allowed = set(sys.stdlib_module_names) | local_names(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                mods = [node.module]
            else:
                continue
            for mod in mods:
                if mod.split(".")[0] not in allowed:
                    problems.append(f"{path.relative_to(ROOT)}: imports non-stdlib {mod}")
    return problems


def own_addresses() -> set[str]:
    """This machine's non-loopback IPv4 addresses (best effort; empty where `ip` is absent)."""
    try:
        out = subprocess.run(["ip", "-4", "-o", "addr"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return set()
    return {a for a in re.findall(r"inet (\d{1,3}(?:\.\d{1,3}){3})", out) if not a.startswith("127.")}


def check_hygiene() -> list[str]:
    problems = []
    machine = socket.gethostname()
    own = own_addresses()
    task_text = "\n".join(path.read_bytes().decode("utf-8", errors="replace") for path in files()
                          if path.relative_to(ROOT).parts[0] in ("tasks", "examples"))
    task_addresses = set(IPV4_RE.findall(task_text))
    for path in files():
        text = path.read_bytes().decode("utf-8", errors="replace")
        rel = path.relative_to(ROOT)
        transcript = rel.parts[0] == "results" and "transcripts" in rel.parts
        scan = text.replace(PLACEHOLDER_HOME, "") if transcript else text
        for m in SECRET_RE.finditer(scan):
            problems.append(f"{rel}: suspicious text {m.group(0)[:20]!r}")
        if transcript:
            seen = set(IPV4_RE.findall(text)) - task_addresses
            private = (seen & own) | {a for a in seen if OVERLAY_IP_RE.fullmatch(a)}
            private |= {m.group(0).lower() for m in PRIVATE_HOST_RE.finditer(text)}
            if len(machine) >= 4 and machine in text:
                private.add(machine)
            for host in sorted(private):
                problems.append(f"{rel}: names private host {host!r}")
        elif rel.parts[0] == "results":
            # Run metadata may name loopback hosts only, apart from hosts quoted from task data (a check's output
            # can repeat a fixture's sample URL). This machine's name and addresses are never allowed.
            hosts = {re.match(r"[a-z0-9.-]*", m.group(1).lower()).group(0).strip(".-")
                     for m in URL_HOST_RE.finditer(text)}
            hosts |= set(IPV4_RE.findall(text))
            for host in sorted(hosts - ALLOWED_HOSTS):
                if host and (host == machine or host in own or host not in task_text):
                    problems.append(f"{rel}: names host {host!r}; results may name only local hosts")
    return problems


def cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "alcorbench", *args], cwd=ROOT,
                          capture_output=True, text=True, timeout=900)


def check_cli() -> list[str]:
    problems = []
    res = cli("selfcheck")
    print(res.stdout[-1500:])
    if res.returncode != 0:
        problems.append("selfcheck failed")
    out = Path(tempfile.mkdtemp(prefix="alcorbench-ci-")) / "demo"
    try:
        steps = [
            ("run", cli("run", "--agent", "scripted", "--tasks", "examples/tasks",
                        "--trials", "2", "--out", str(out)), "| all | 2 | 100.0%"),
            ("report", cli("report", str(out)), "DEMO"),
            ("compare", cli("compare", str(out), str(out)), "A better on 0, B better on 0"),
            ("resume of a complete run", cli("run", "--resume", str(out)), "| all | 2 | 100.0%"),
        ]
        for name, res, needle in steps:
            if res.returncode != 0 or needle not in res.stdout:
                problems.append(f"cli {name}: exit {res.returncode}, missing {needle!r}\n"
                                f"{res.stdout[-800:]}{res.stderr[-800:]}")
        if len((out / "trials.jsonl").read_text().splitlines()) != 4:
            problems.append("resuming a complete run re-ran trials")
        res = cli("run", "--agent", "scripted", "--tasks", "examples/tasks",
                  "--out", "results/should-not-exist")
        if res.returncode == 0 or (ROOT / "results" / "should-not-exist").exists():
            problems.append("a scripted run was allowed to write under results/")
    finally:
        shutil.rmtree(out.parent, ignore_errors=True)
    return problems


def main() -> int:
    problems = []
    for name, check in (("imports", check_imports), ("hygiene", check_hygiene),
                        ("cli", check_cli)):
        found = check()
        print(f"[{name}] {'ok' if not found else 'FAILED'}")
        for p in found:
            print(f"  - {p}")
        problems += found
    print(f"ci_check: {'PASS' if not problems else f'FAIL ({len(problems)} problem(s))'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
