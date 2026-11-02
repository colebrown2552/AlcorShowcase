#!/usr/bin/env python3
"""Check that one data directory is served by at most one AlcorDesign server.

A second server on the same data directory (reached through a different path
spelling) must be refused without touching runtime.json. After the first server
is killed the directory must be usable again, and a server on a separate data
directory must run alongside. Servers use OS-assigned ports and no Git checkout.

Usage (Linux):

    python server_data_lock_acceptance.py --binary target/debug/alcor-design

A per-run report is written under --output-root.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from persistent_runtime_acceptance import (
    clean_env,
    mcp_tool_call,
    sha,
    start_server,
    stop_server,
    wait_runtime,
)

APP = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=APP / "target/debug/alcor-design")
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path(tempfile.gettempdir()) / "alcordesign-server-lock-acceptance",
    )
    args = parser.parse_args()
    if os.name != "posix" or not Path("/proc").is_dir():
        parser.error("This acceptance currently requires Linux")
    binary = args.binary.resolve(strict=True)
    app = APP
    if not os.access(binary, os.X_OK):
        parser.error("--binary must be executable")

    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    run = output_root / ("lock-" + uuid.uuid4().hex)
    run.mkdir(mode=0o700)
    shared = run / "shared" / "data"
    shared.parent.mkdir()
    alias_parent = shared.parent / "alias"
    alias_parent.mkdir()
    # Existing path component permits canonicalization while preserving a
    # different lexical path to the same underlying directory.
    alias = alias_parent / ".." / "data"
    independent = run / "independent-data"
    env = clean_env({"ALCORDESIGN_APP_DIR": str(app), "NO_PROXY": "*", "no_proxy": "*"})
    shared_env = clean_env(
        {
            "ALCORDESIGN_DATA_DIR": str(shared),
            "ALCORDESIGN_APP_DIR": str(app),
            "NO_PROXY": "*",
            "no_proxy": "*",
        }
    )
    independent_env = clean_env(
        {
            "ALCORDESIGN_DATA_DIR": str(independent),
            "ALCORDESIGN_APP_DIR": str(app),
            "NO_PROXY": "*",
            "no_proxy": "*",
        }
    )
    shared_runtime = shared / "runtime.json"
    independent_runtime = independent / "runtime.json"
    processes: list[subprocess.Popen] = []
    checks: list[dict] = []
    failure = None
    first = second = restarted = separate = None

    def record(name: str, details: dict) -> None:
        checks.append({"name": name, "status": "PASS", **details})

    try:
        first, _first_log = start_server(binary, app, shared, env, run, "server-first")
        processes.append(first)
        first_port = wait_runtime(first, shared_runtime)
        first_descriptor = shared_runtime.read_bytes()

        second, second_log = start_server(binary, app, alias, env, run, "server-second-alias")
        processes.append(second)
        try:
            second_exit = second.wait(timeout=12)
        except subprocess.TimeoutExpired:
            stop_server(second)
            raise AssertionError(
                "second server stayed running against the locked data root"
            ) from None
        assert second_exit != 0, "second server unexpectedly started against the same data root"
        diagnostic = second_log.read_text(encoding="utf-8", errors="replace")
        assert "already holds the data directory lock" in diagnostic, (
            "second server failed without the expected lock diagnostic"
        )
        assert shared_runtime.read_bytes() == first_descriptor, (
            "rejected server changed the first server's runtime descriptor"
        )
        record(
            "second server rejected before runtime rewrite",
            {
                "same_canonical_data_root": True,
                "runtime_descriptor_unchanged": True,
                "second_exit": second_exit,
                "server_log": str(second_log),
            },
        )

        status = mcp_tool_call(binary, "design_status", {}, shared_env)
        assert status.get("name") == "AlcorDesign", "MCP status did not reach the first server"
        assert status.get("url") == f"http://127.0.0.1:{first_port}", (
            "MCP status reached an unexpected server port"
        )
        record("MCP status works while server owns lock", {"server_port": first_port})

        # Abruptly terminate only the child process launched by this harness.
        first.kill()
        first_exit = first.wait(timeout=5)
        assert first_exit != 0, "SIGKILL unexpectedly returned a successful server exit"
        assert shared_runtime.read_bytes() == first_descriptor, (
            "runtime descriptor changed during isolated process termination"
        )
        record(
            "kernel releases lock after server process is killed",
            {"server_exit": first_exit, "runtime_descriptor_preserved": True},
        )

        restarted, restart_log = start_server(binary, app, alias, env, run, "server-restarted")
        processes.append(restarted)
        restart_port = wait_runtime(restarted, shared_runtime)
        restart_status = mcp_tool_call(binary, "design_status", {}, shared_env)
        assert restart_status.get("url") == f"http://127.0.0.1:{restart_port}", (
            "server did not restart using the released lock"
        )
        record(
            "same root restarts after killed owner exits",
            {"restart_port": restart_port, "server_log": str(restart_log)},
        )

        separate, separate_log = start_server(
            binary, app, independent, env, run, "server-independent-root"
        )
        processes.append(separate)
        separate_port = wait_runtime(separate, independent_runtime)
        assert restart_port != separate_port
        separate_status = mcp_tool_call(binary, "design_status", {}, independent_env)
        assert separate_status.get("url") == f"http://127.0.0.1:{separate_port}"
        record(
            "independent data roots can run concurrently",
            {
                "shared_restart_port": restart_port,
                "independent_port": separate_port,
                "independent_log": str(separate_log),
            },
        )
    except Exception as error:
        failure = f"{type(error).__name__}: {str(error)[:500]}"
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                stop_server(process)

    report = {
        "status": "FAIL" if failure else "PASS",
        "run_dir": str(run),
        "binary_sha256": sha(binary),
        "runner_sha256": sha(Path(__file__).resolve()),
        "checks": checks,
        "failure": failure,
    }
    report_path = run / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "report": str(report_path),
                "status": report["status"],
                "checks": len(checks),
                "failure": failure,
            },
            sort_keys=True,
        )
    )
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
