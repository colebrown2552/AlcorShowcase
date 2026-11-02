"""Run the standing contract (``contract.json``) against a deployed site and write a sealed receipt.

A suite is any script that takes the site's base URL as its first argument, prints ``PASS ...`` and
``FAIL ...`` lines and exits non-zero on failure. Every suite runs against the site exactly as it
is served. A run is green only if every suite exits 0, prints no FAIL line and printed at least
one PASS: a suite that checked nothing proves nothing.

The receipt holds counts, the commit that was served and each suite file's SHA-256; never page
text. Only a *complete* run (no ``--only``) becomes ``latest.json``, the file the promote gate
reads. A hand-picked subset can be green while the contract as a whole is not, so subsets are
written elsewhere and cannot stand in for the real thing.
"""

from __future__ import annotations

import concurrent.futures
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .fsutil import read_json, sha256_file
from .net import served_commit
from .receipts import write_sealed


class ContractError(Exception):
    """Raised when the contract file or the requested suites are not usable."""


def load_suites(path: Path) -> list[dict[str, Any]]:
    """Read and validate the suite list from a contract file.

    Raises:
        ContractError: if the file is missing, malformed, or has duplicate or nameless suites.
    """
    data = read_json(path)
    if not isinstance(data, dict) or not isinstance(data.get("suites"), list):
        raise ContractError(f"{path.name} must hold an object with a 'suites' list")
    names: set[str] = set()
    for suite in data["suites"]:
        name = suite.get("name") if isinstance(suite, dict) else None
        if not name or not suite.get("file") or name in names:
            raise ContractError(f"{path.name}: every suite needs a unique name and a file")
        names.add(name)
    return list(data["suites"])


def counts(text: str) -> tuple[int, int]:
    """Count PASS and FAIL lines in a suite's output.

    Suites that print only a summary line (``1323 PASS, 0 FAIL``) are read from that line.
    """
    passed = len(re.findall(r"^PASS", text, re.MULTILINE))
    failed = len(re.findall(r"^FAIL", text, re.MULTILINE))
    if passed == 0 and failed == 0:
        match = re.search(r"(\d+) PASS, (\d+) FAIL", text)
        if match:
            passed, failed = int(match.group(1)), int(match.group(2))
    return passed, failed


def _command(suite: dict[str, Any], root: Path, url: str, logs: Path) -> list[str]:
    path = root / suite["file"]
    runner = {".py": [sys.executable], ".mjs": ["node"], ".js": ["node"]}.get(
        path.suffix.lower(), []
    )
    command = [*runner, str(path), url, *suite.get("args", [])]
    if suite.get("out_flag"):  # suites that write files (screenshots) get a folder of their own
        command += [suite["out_flag"], str(logs / suite["name"])]
    return command


def _run_suite(
    suite: dict[str, Any], root: Path, url: str, logs: Path, timeout: float
) -> tuple[dict[str, Any], str]:
    """Run one suite; return its receipt row and its output (printing is the caller's job)."""
    command = _command(suite, root, url, logs)
    path = root / suite["file"]
    if not path.is_file():
        text, code = "FAIL suite file is missing", 127
    elif shutil.which(command[0]) is None:
        text, code = f"FAIL cannot start suite: {Path(command[0]).name} is not installed", 127
    else:
        env = {**os.environ, "PYTHONUTF8": "1"}
        try:
            done = subprocess.run(
                command,
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
            text, code = done.stdout + done.stderr, done.returncode
        except subprocess.TimeoutExpired:
            text, code = f"FAIL suite timed out after {timeout:.0f}s", 124
    (logs / f"{suite['name']}.txt").write_text(text, encoding="utf-8")
    passed, failed = counts(text)
    row = {
        "suite": suite["name"],
        "rc": code,
        "pass": passed,
        "fail": failed,
        "ok": code == 0 and failed == 0 and passed > 0,
        "sha256": sha256_file(path) if path.is_file() else None,
    }
    return row, text


def _print_row(row: dict[str, Any], text: str) -> None:
    """Print one suite's verdict line and its first few FAIL lines."""
    mark = "ok  " if row["ok"] else "FAIL"
    print(f"{mark} {row['suite']:<16} pass={row['pass']} fail={row['fail']} rc={row['rc']}")
    for line in [line for line in text.splitlines() if line.startswith("FAIL")][:4]:
        print(f"       {line[:180]}")
    sys.stdout.flush()


def run_contract(
    contract_file: Path,
    home: Path,
    url: str,
    *,
    only: str | None = None,
    prod: bool = False,
    jobs: int = 5,
    timeout: float = 1800.0,
) -> dict[str, Any]:
    """Run the suites against ``url``, write the receipt and return it.

    Args:
        contract_file: the ``contract.json`` listing the suites; suite paths resolve against
            its folder.
        home: sitekit's state folder; receipts go under it.
        url: base URL of the site to test.
        only: comma-separated suite names to run instead of all of them.
        prod: run only suites marked ``prod_safe`` (they read pages and send nothing), and write
            under ``receipts-prod`` so a production run can never replace staging's receipt.
        jobs: how many suites may run at once. Suites marked ``alone`` (they measure speed or
            pixels) run afterwards, one at a time, so they are not disturbed by the others.
        timeout: seconds before a single suite is killed and counted as failed.

    Raises:
        ContractError: for an unusable contract file or an unknown suite name in ``only``.
    """
    all_suites = load_suites(contract_file)
    suites = all_suites
    if only:
        wanted = {name.strip() for name in only.split(",") if name.strip()}
        unknown = sorted(wanted - {suite["name"] for suite in all_suites})
        if unknown:
            raise ContractError(f"unknown suite(s): {', '.join(unknown)}")
        suites = [suite for suite in all_suites if suite["name"] in wanted]
    if prod:
        suites = [suite for suite in suites if suite.get("prod_safe")]
    out = home / ("receipts-prod" if prod else "receipts")
    stamp = f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}Z"
    logs = out / f"contract-{stamp}"
    logs.mkdir(parents=True, exist_ok=True)
    before = served_commit(url)
    print(f"contract: {len(suites)} suites against the site (serving {before[:8] or 'unknown'})")
    root = contract_file.parent
    together = [suite for suite in suites if not suite.get("alone")]
    solo = [suite for suite in suites if suite.get("alone")]
    rows: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        # `map` yields in submission order, so the printed order is the same on every run even
        # though the suites finish in any order.
        for row, text in pool.map(lambda s: _run_suite(s, root, url, logs, timeout), together):
            _print_row(row, text)
            rows.append(row)
    for suite in solo:
        row, text = _run_suite(suite, root, url, logs, timeout)
        _print_row(row, text)
        rows.append(row)
    # The commit is read again afterwards: if staging moved while the suites ran, the run measured
    # a mixture and says nothing about either commit.
    after = served_commit(url)
    moved = after != before
    green = bool(rows) and all(row["ok"] for row in rows) and not moved
    try:
        shown_logs = logs.relative_to(home).as_posix()
    except ValueError:
        shown_logs = logs.name
    receipt = {
        "kind": "sitekit-contract",
        "at": stamp,
        "served_commit": before,
        "served_commit_after": after,
        "prod_mode": prod,
        "complete": not only,
        "suites": rows,
        "pass": sum(row["pass"] for row in rows),
        "fail": sum(row["fail"] for row in rows),
        "green": green,
        "logs": shown_logs,
    }
    write_sealed(logs / "receipt.json", receipt)
    write_sealed(out / ("latest.json" if not only else "latest-partial.json"), receipt)
    if moved:
        print(f"the served commit changed during the run ({before[:8]} -> {after[:8]}): not green")
    verdict = "GREEN" if green else "RED"
    totals = f"{receipt['pass']} pass, {receipt['fail']} fail"
    print(f"contract {verdict}: {totals}; receipt {shown_logs}/receipt.json")
    return receipt
