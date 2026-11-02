#!/usr/bin/env python3
"""Check that bad command lines are refused before any state is created.

Each rejected invocation must exit non-zero and leave the (isolated) data
directory absent. Then one server is started on an OS-assigned port and a
one-shot `call design_status` must reach it through runtime.json.

Usage:

    python cli_safety_acceptance.py --binary target/debug/alcor-design \\
        --output-root /path/to/existing/scratch/dir
"""

import argparse
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
from pathlib import Path

app = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument("--output-root", type=Path, required=True)
options = parser.parse_args()
binary = options.binary.resolve(strict=True)
output_root = options.output_root.resolve(strict=True)
run = Path(tempfile.mkdtemp(prefix="cli-safety-", dir=output_root))
data = run / "isolated-data"
env = os.environ.copy()
env["ALCORDESIGN_APP_DIR"] = str(app)
env["ALCORDESIGN_DATA_DIR"] = str(data)
for name in ("ALCORDESIGN_GITHUB_REPO", "ALCORDESIGN_RUNTIME"):
    env.pop(name, None)
checks = []
failures = []
server = None


def check(name, fn):
    try:
        fn()
        checks.append(name)
    except Exception as exc:
        failures.append({"check": name, "error": f"{type(exc).__name__}: {exc}"})


def no_effect(args, expect_ok):
    result = subprocess.run(
        [str(binary), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=4,
    )
    assert (result.returncode == 0) == expect_ok, (
        f"unexpected exit {result.returncode} for {args!r}"
    )
    if expect_ok:
        assert "AlcorDesign 0.1" in result.stdout
    assert not data.exists(), f"CLI unexpectedly created a data directory for {args!r}"


try:
    check(
        "serve --help prints help without creating runtime state",
        lambda: no_effect(["serve", "--help"], True),
    )
    check(
        "top-level help prints help without creating runtime state",
        lambda: no_effect(["--help"], True),
    )
    for label, args in [
        ("unknown command", ["server"]),
        ("unknown option", ["serve", "--unknown", "x"]),
        ("missing value", ["serve", "--repo"]),
        ("option used as value", ["serve", "--data", "--help"]),
        ("duplicate port", ["serve", "--port", "0", "--port", "0"]),
        ("repo without a GitHub repository", ["serve", "--repo", str(output_root)]),
        ("extra mcp argument", ["mcp", "unexpected"]),
        ("missing call tool", ["call"]),
    ]:
        check(label + " is rejected before runtime state", lambda args=args: no_effect(args, False))
    assert not failures, "Refusing to start a server after CLI no-effect checks failed"
    server = subprocess.Popen(
        [str(binary), "serve", "--data", str(data), "--port", "0"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError("isolated server exited before readiness")
        try:
            port = json.loads((data / "runtime.json").read_text(encoding="utf-8"))["port"]
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.1)
    else:
        raise RuntimeError("isolated server did not become ready")
    result = subprocess.run(
        [str(binary), "call", "design_status", "{}"],
        env=env,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 0, "status call failed"
    status = json.loads(result.stdout)
    assert status.get("name") == "AlcorDesign", "unexpected status response"
    checks.append("explicit isolated serve and one-shot status call work")
except Exception as exc:
    failures.append({"check": "isolated serve", "error": f"{type(exc).__name__}: {exc}"})
finally:
    if server is not None and server.poll() is None:
        server.send_signal(signal.SIGINT)
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
            failures.append(
                {"check": "server shutdown", "error": "server required forced termination"}
            )
    report = {
        "ok": not failures,
        "scope": "isolated actual binary; no-effect CLI parsing and one loopback server",
        "checks": checks,
        "failures": failures,
        "server_stopped": server is None or server.poll() is not None,
        "run_dir": str(run),
    }
    (run / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
if failures:
    raise SystemExit(1)
