"""Run every component's checks and end-to-end demos from one command.

Each component declares its own steps in ``scripts/checks.json`` (lint, existing tests, demo), so
this runner stays generic: it executes the steps in order, from the repository root, and prints a
pass/fail table. A CI job can run the same file, so "works on my machine" and "works in CI" stay
the same claim.

Usage:
    python scripts/check.py                 # everything
    python scripts/check.py AlcorLang       # one component
    python scripts/check.py --list          # show components and steps
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
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


def run_step(component: str, step: dict) -> tuple[str, float]:
    """Run one step and return its status ("pass", "FAIL", "skip") and duration."""
    argv = resolve(step["run"])
    if argv is None:
        return ("skip" if step.get("optional") else "FAIL"), 0.0
    cwd = ROOT / step.get("cwd", ".")
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    started = time.monotonic()
    # Shell is never used: every step is an argv list, so paths with spaces and odd characters
    # can't be reinterpreted.
    result = subprocess.run(argv, cwd=cwd, env=env, check=False)
    return ("pass" if result.returncode == 0 else "FAIL"), time.monotonic() - started


def main() -> int:
    """Parse arguments, run the selected components and report a summary table."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("components", nargs="*", help="limit the run to these components")
    parser.add_argument("--list", action="store_true", help="print components and steps")
    args = parser.parse_args()

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
        print(f"{status:<5} {name:<18} {step_name:<24} {seconds:6.1f}s")
    failed = [r for r in rows if r[2] == "FAIL"]
    print(f"\n{len(rows) - len(failed)}/{len(rows)} steps passed or skipped, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
