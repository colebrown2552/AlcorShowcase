"""Run every component's checks and end-to-end demos from one command.

Each component declares its own steps in ``scripts/checks.json`` (lint, existing tests, demo), so
this runner stays generic: it executes the steps in order, from the repository root, and prints a
pass/fail table. A CI job can run the same file, so "works on my machine" and "works in CI" stay
the same claim.

Usage:
    python scripts/check.py                 # everything
    python scripts/check.py AlcorLang       # one component
    python scripts/check.py --list          # show components and steps
    python scripts/check.py --strict        # a missing required tool or a timeout fails the run
    python scripts/check.py --json out.json # also write the results as JSON

A step may set ``"timeout"`` (seconds). When it expires the step's whole process group is killed
and the step is reported as ``timeout``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "scripts" / "checks.json"


def load_manifest() -> dict[str, list[dict]]:
    """Load the component -> steps mapping, failing loudly on a malformed file."""
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not all(isinstance(v, list) for v in data.values()):
        raise SystemExit(f"{MANIFEST} must map component names to lists of steps")
    return data


def resolve(argv: list[str]) -> list[str] | None:
    """Swap the placeholder ``{python}`` for this interpreter; None if a tool is missing.

    Steps name their tool as the first argument. A missing optional tool (``"optional": true``)
    is reported as skipped rather than failed, so a machine without Rust can still run the Python
    checks, while a full CI install treats every step as required.
    """
    resolved = [sys.executable if a == "{python}" else a for a in argv]
    if resolved[0] != sys.executable and shutil.which(resolved[0]) is None:
        return None
    return resolved


def kill_group(proc: subprocess.Popen) -> None:
    """Kill the step's whole process group so child processes cannot outlive a timeout."""
    try:
        if os.name == "nt":
            proc.kill()
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def run_step(component: str, step: dict) -> tuple[str, float]:
    """Run one step and return its status ("pass", "fail", "skip", "timeout") and duration."""
    argv = resolve(step["run"])
    if argv is None:
        return ("skip" if step.get("optional") else "fail"), 0.0
    cwd = ROOT / step.get("cwd", ".")
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    started = time.monotonic()
    # Shell is never used: every step is an argv list, so paths with spaces and odd characters
    # can't be reinterpreted. Each step gets its own process group so a timeout can kill it all.
    kwargs = {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)} if os.name == "nt" else {"start_new_session": True}
    proc = subprocess.Popen(argv, cwd=cwd, env=env, **kwargs)
    try:
        code = proc.wait(timeout=step.get("timeout"))
    except subprocess.TimeoutExpired:
        kill_group(proc)
        return "timeout", time.monotonic() - started
    # A step that exits normally may still have left children behind; reap the group.
    if os.name != "nt":
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return ("pass" if code == 0 else "fail"), time.monotonic() - started


def summarize(rows: list[tuple[str, str, str, float]]) -> dict[str, int]:
    """Count rows by status; a timeout also counts as a failure."""
    counts = {"pass": 0, "fail": 0, "skip": 0}
    for _, _, status, _ in rows:
        counts["fail" if status == "timeout" else status] += 1
    return counts


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, run the selected components and report a summary table."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("components", nargs="*", help="limit the run to these components")
    parser.add_argument("--list", action="store_true", help="print components and steps")
    parser.add_argument("--strict", action="store_true", help="a required step that cannot run fails the run; skips stay visible")
    parser.add_argument("--json", metavar="PATH", help="write the results as JSON to PATH")
    args = parser.parse_args(argv)

    manifest = load_manifest()
    selected = args.components or list(manifest)
    unknown = [c for c in selected if c not in manifest]
    if unknown:
        raise SystemExit(f"unknown component(s): {', '.join(unknown)}")

    if args.list:
        for name in selected:
            for step in manifest[name]:
                print(f"{name:<18} {step['name']:<22} {' '.join(step['run'])}")
        return 0

    rows = []
    for name in selected:
        for step in manifest[name]:
            print(f"\n=== {name}: {step['name']} ===", flush=True)
            status, seconds = run_step(name, step)
            rows.append((name, step["name"], status, seconds))

    print("\n" + "-" * 64)
    for name, step_name, status, seconds in rows:
        print(f"{status:<7} {name:<18} {step_name:<24} {seconds:6.1f}s")
    counts = summarize(rows)
    print(f"\n{counts['pass']} passed, {counts['fail']} failed, {counts['skip']} skipped of {len(rows)} steps")
    if args.json:
        payload = {
            "strict": args.strict,
            "counts": counts,
            "steps": [
                {"component": c, "name": n, "status": s, "seconds": round(t, 3)} for c, n, s, t in rows
            ],
        }
        Path(args.json).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 1 if counts["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
