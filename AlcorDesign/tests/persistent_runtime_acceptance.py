#!/usr/bin/env python3
"""Check AlcorDesign data-directory and runtime discovery in isolation (Linux).

The runner starts its own loopback servers with an OS-assigned port, imports a
synthetic local HTML page, restarts the server, and checks that the one-shot
CLI client and the MCP client find the right server through runtime.json. It
also checks the precedence of --data, ALCORDESIGN_DATA_DIR, ALCORDESIGN_RUNTIME
and XDG_DATA_HOME. No Git checkout is needed and nothing remote is contacted.

Usage:

    python persistent_runtime_acceptance.py --binary target/debug/alcor-design \\
        --playwright /path/to/playwright/index.mjs --chrome /path/to/chrome

--playwright and --chrome default to ALCORDESIGN_PLAYWRIGHT and
ALCORDESIGN_CHROME. A per-run evidence report is written under --output-root.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.client
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
PROTOCOL = "2025-06-18"
MAX_WAIT = 35


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Retain executable lookup but remove every runtime/data override."""
    env = os.environ.copy()
    for key in (
        "LOCALAPPDATA",
        "ALCORDESIGN_RUNTIME",
        "ALCORDESIGN_DATA_DIR",
        "DATA_DIR",
        "XDG_DATA_HOME",
        "HOME",
    ):
        env.pop(key, None)
    if extra:
        env.update(extra)
    return env


def runtime_secret(path: Path) -> tuple[int, str]:
    value = json.loads(path.read_text(encoding="utf-8"))
    port = value.get("port")
    token = value.get("token")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise AssertionError("runtime descriptor has an invalid port")
    if not isinstance(token, str) or len(token) < 16:
        raise AssertionError("runtime descriptor has invalid authentication")
    return port, token


def wait_runtime(process: subprocess.Popen, path: Path, timeout: float = 20) -> int:
    """Wait for this process's runtime.json and return the port it chose."""
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if process.poll() is not None:
            raise AssertionError("isolated AlcorDesign exited during startup")
        if path.is_file():
            try:
                owner = json.loads(path.read_text(encoding="utf-8")).get("pid")
                port, _token = runtime_secret(path)
                if owner == process.pid:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        return port
            except (OSError, ValueError):
                pass
        time.sleep(0.05)
    raise AssertionError("isolated AlcorDesign did not create its runtime descriptor")


def tool_http(runtime: Path, name: str, arguments: dict) -> dict:
    port, token = runtime_secret(runtime)
    body = json.dumps({"name": name, "arguments": arguments}).encode("utf-8")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    try:
        connection.request(
            "POST",
            "/api/tools",
            body=body,
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
                "Host": f"127.0.0.1:{port}",
            },
        )
        response = connection.getresponse()
        raw = response.read(5_000_001)
        if len(raw) > 5_000_000:
            raise AssertionError("isolated tool response exceeded limit")
        value = json.loads(raw)
        if response.status != 200:
            raise AssertionError(f"isolated {name} returned HTTP {response.status}")
        if not isinstance(value, dict):
            raise AssertionError(f"isolated {name} returned invalid JSON")
        return value
    finally:
        connection.close()


def get_job(runtime: Path, job_id: str) -> dict:
    port, token = runtime_secret(runtime)
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(
            "GET",
            "/api/jobs/" + job_id,
            headers={"Authorization": "Bearer " + token, "Host": f"127.0.0.1:{port}"},
        )
        response = connection.getresponse()
        raw = response.read(256_001)
        if len(raw) > 256_000:
            raise AssertionError("job response exceeded limit")
        value = json.loads(raw)
        if response.status != 200:
            raise AssertionError(f"isolated job lookup returned HTTP {response.status}")
        return value
    finally:
        connection.close()


def mcp_tool_call(
    binary: Path, name: str, arguments: dict, env: dict[str, str], timeout: float = 20
) -> dict:
    messages = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL,
                "capabilities": {},
                "clientInfo": {"name": "persistent runtime acceptance", "version": "1"},
            },
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    ]
    wire = "\n".join(json.dumps(row, separators=(",", ":")) for row in messages) + "\n"
    result = subprocess.run(
        [str(binary), "mcp"],
        input=wire,
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"MCP client exited {result.returncode}")
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    response = next((row for row in rows if row.get("id") == 2), None)
    if response is None or "error" in response:
        raise AssertionError(f"MCP {name} did not return a result")
    value = response.get("result", {})
    if value.get("isError"):
        text = " ".join(item.get("text", "") for item in value.get("content", []))
        raise AssertionError(f"MCP {name} failed: {text[:300]}")
    structured = value.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    for item in value.get("content", []):
        if item.get("type") == "text":
            try:
                parsed = json.loads(item["text"])
                if isinstance(parsed, dict):
                    return parsed
            except (ValueError, KeyError):
                pass
    raise AssertionError(f"MCP {name} omitted structured JSON")


def one_shot_status(binary: Path, env: dict[str, str], timeout: float = 15) -> dict:
    result = subprocess.run(
        [str(binary), "call", "design_status", "{}"],
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        # Keep a useful diagnostic while removing the exact runtime secret.
        diagnostic = (result.stderr + result.stdout).strip()
        candidates = []
        if env.get("ALCORDESIGN_RUNTIME"):
            candidates.append(Path(env["ALCORDESIGN_RUNTIME"]))
        elif env.get("ALCORDESIGN_DATA_DIR"):
            candidates.append(Path(env["ALCORDESIGN_DATA_DIR"]) / "runtime.json")
        elif env.get("XDG_DATA_HOME"):
            candidates.append(Path(env["XDG_DATA_HOME"]) / "AlcorDesign" / "runtime.json")
        elif env.get("HOME"):
            candidates.append(
                Path(env["HOME"]) / ".local" / "share" / "AlcorDesign" / "runtime.json"
            )
        for candidate in candidates:
            try:
                token = json.loads(candidate.read_text(encoding="utf-8")).get("token")
                if isinstance(token, str) and token:
                    diagnostic = diagnostic.replace(token, "[redacted]")
            except (OSError, ValueError, AttributeError):
                pass
        raise AssertionError(
            f"one-shot design_status failed ({result.returncode}): {diagnostic[:250]}"
        )
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or value.get("name") != "AlcorDesign":
        raise AssertionError("one-shot design_status returned the wrong workspace")
    if "token" in result.stdout.lower() or "authorization" in result.stdout.lower():
        raise AssertionError("one-shot client exposed authentication material")
    return value


def start_server(
    binary: Path, app: Path, data_arg: Path | None, env: dict[str, str], run: Path, label: str
) -> tuple[subprocess.Popen, Path]:
    args = [str(binary), "serve", "--port", "0"]
    if data_arg is not None:
        args.extend(["--data", str(data_arg)])
    log_path = run / f"{label}.log"
    log = log_path.open("xb")
    process = subprocess.Popen(
        args,
        cwd=app,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    # The parent process owns this stream handle; close it here while the child
    # retains its inherited descriptor.
    log.close()
    return process, log_path


def stop_server(process: subprocess.Popen) -> int:
    if process.poll() is None:
        process.send_signal(signal.SIGINT)
    try:
        return process.wait(timeout=12)
    except subprocess.TimeoutExpired:
        # Only this harness's process is signalled; no process-name matching.
        process.terminate()
        try:
            return process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.wait(timeout=3)


def check_report(name: str, details: dict) -> dict:
    return {"name": name, "status": "PASS", **details}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=APP / "target/debug/alcor-design")
    parser.add_argument(
        "--playwright",
        type=Path,
        default=os.environ.get("ALCORDESIGN_PLAYWRIGHT"),
        help="local Playwright index.mjs; no package installation is performed",
    )
    parser.add_argument(
        "--chrome",
        type=Path,
        default=os.environ.get("ALCORDESIGN_CHROME"),
        help="existing local Chrome/Chromium executable",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path(tempfile.gettempdir()) / "alcordesign-persistent-runtime-acceptance",
    )
    args = parser.parse_args()
    if os.name != "posix" or not Path("/proc").is_dir():
        parser.error("This isolated runtime acceptance currently requires Linux.")
    if args.playwright is None or args.chrome is None:
        parser.error("--playwright and --chrome (or their ALCORDESIGN_* variables) are required")
    binary, playwright, chrome = [
        value.resolve(strict=True) for value in (args.binary, args.playwright, args.chrome)
    ]
    app = APP
    if not (app / "src/main.rs").is_file() or not (app / "renderer/worker.mjs").is_file():
        parser.error("this test must live in an AlcorDesign checkout")
    if not os.access(binary, os.X_OK):
        parser.error("--binary must be executable")
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    run = output_root / ("runtime-" + uuid.uuid4().hex)
    run.mkdir(mode=0o700)
    evidence_dir = run / "evidence"
    evidence_dir.mkdir(mode=0o700)

    checks: list[dict] = []
    processes: list[subprocess.Popen] = []
    failures: list[str] = []
    summary: dict = {
        "run_dir": str(run),
        "runner_sha256": sha(Path(__file__).resolve()),
        "binary_sha256": sha(binary),
        "playwright_sha256": sha(playwright),
        "chrome_sha256": sha(chrome),
        "checks": checks,
    }

    def record(name: str, function) -> None:
        try:
            details = function()
            checks.append(check_report(name, details or {}))
        except Exception as error:  # evidence needs a precise failing check
            message = f"{type(error).__name__}: {str(error)[:500]}"
            checks.append({"name": name, "status": "FAIL", "reason": message})
            failures.append(f"{name}: {message}")

    # No explicit runtime or data directory: the server must place its real
    # runtime and project under this run's XDG tree.
    xdg_root = run / "xdg-data"
    xdg_env = clean_env(
        {
            "XDG_DATA_HOME": str(xdg_root),
            "ALCORDESIGN_APP_DIR": str(app),
            "ALCORDESIGN_PLAYWRIGHT": str(playwright),
            "ALCORDESIGN_CHROME": str(chrome),
            "NO_PROXY": "*",
            "no_proxy": "*",
        }
    )
    default_data = xdg_root / "AlcorDesign"
    runtime = default_data / "runtime.json"
    server = None

    def primary_restart_and_mcp() -> dict:
        nonlocal server
        server, log_path = start_server(binary, app, None, xdg_env, run, "xdg-server-1")
        processes.append(server)
        port = wait_runtime(server, runtime)
        status = one_shot_status(binary, xdg_env)
        assert status["url"] == f"http://127.0.0.1:{port}", "default client reached the wrong app"
        rpc = mcp_tool_call(binary, "design_status", {}, xdg_env)
        assert rpc["url"] == status["url"], "MCP tools/call did not use XDG runtime"

        # Local-only, inert HTML has no external scripts, stylesheets or assets.
        title = "Persistent runtime " + run.name[-10:]
        html = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>{title}</title><style>body{{font:16px sans-serif}}</style>"
            f"</head><body><main><h1>{title}</h1><p>Saved fixture</p></main></body></html>"
        )
        created = mcp_tool_call(
            binary,
            "design_import_html",
            {
                "html": html,
                "name": title,
                # The base URL only names the page; this HTML has no external
                # URLs, so rendering stays fully local.
                "base_url": "https://www.example.com/persistent-fixture",
            },
            xdg_env,
        )
        project_id = created.get("project_id")
        job_id = created.get("job_id")
        assert isinstance(project_id, str) and isinstance(job_id, str), (
            "MCP HTML import omitted project/job identity"
        )

        deadline = time.monotonic() + MAX_WAIT
        job = {}
        while time.monotonic() < deadline:
            job = get_job(runtime, job_id)
            if job.get("status") in {"completed", "partial", "failed"}:
                break
            if server.poll() is not None:
                raise AssertionError("server exited while synthetic import ran")
            time.sleep(0.2)
        if job.get("status") not in {"completed", "partial"}:
            raise AssertionError("synthetic HTML renderer did not complete successfully")
        project = tool_http(runtime, "design_get_project", {"project_id": project_id})
        pages = project.get("pages", [])
        if not pages:
            raise AssertionError("synthetic import did not persist a page")
        if not any(
            page.get("status") == "ready" and page.get("node_count", 0) >= 1 for page in pages
        ):
            raise AssertionError(
                "synthetic HTML page was not actually rendered into editable layers"
            )
        if not (default_data / "projects" / project_id / "project.json").is_file():
            raise AssertionError("project JSON is absent from the discovered XDG data directory")

        first_stop = stop_server(server)
        if first_stop != 0:
            raise AssertionError(f"first app did not stop gracefully (exit {first_stop})")
        server = None
        if (
            not runtime.is_file()
            or not (default_data / "projects" / project_id / "project.json").is_file()
        ):
            raise AssertionError("runtime or project data disappeared after graceful stop")

        server, log_path2 = start_server(binary, app, None, xdg_env, run, "xdg-server-2")
        processes.append(server)
        port2 = wait_runtime(server, runtime)
        status2 = one_shot_status(binary, xdg_env)
        assert status2["url"] == f"http://127.0.0.1:{port2}", (
            "one-shot client did not discover the restarted server"
        )
        mcp_projects = mcp_tool_call(binary, "design_list_projects", {}, xdg_env)
        ids = [item.get("id") for item in mcp_projects.get("projects", [])]
        if project_id not in ids:
            raise AssertionError("MCP client did not see the saved synthetic project after restart")
        restored = tool_http(runtime, "design_get_project", {"project_id": project_id})
        restored_pages = restored.get("pages", [])
        if restored.get("name") != title or not restored_pages:
            raise AssertionError("project metadata/pages did not survive graceful restart")
        if not any(
            page.get("status") == "ready" and page.get("node_count", 0) >= 1
            for page in restored_pages
        ):
            raise AssertionError(
                "rendered page state or editable layer index did not survive restart"
            )
        # The API reports jobs as process-local; this assertion makes the
        # persistence boundary explicit instead of claiming jobs are durable.
        return {
            "data_root": str(default_data),
            "project_id": project_id,
            "job_terminal_status_before_restart": job.get("status"),
            "page_count_before_restart": len(pages),
            "page_count_after_restart": len(restored_pages),
            "restored_page_statuses": [p.get("status") for p in restored_pages],
            "server_ports": [port, port2],
            "graceful_first_exit": first_stop,
            "one_shot_design_status": True,
            "mcp_tools_call_status": True,
            "server_logs": [str(log_path), str(log_path2)],
        }

    record(
        "XDG runtime, real synthetic render, graceful restart and project persistence",
        primary_restart_and_mcp,
    )
    if server is not None:
        code = stop_server(server)
        if code != 0:
            failures.append(f"cleanup of owned XDG server returned {code}")
        server = None

    # An explicit runtime path wins over default runtime discovery. Here the
    # implicit XDG root deliberately has no runtime descriptor.
    runtime_override_data = run / "runtime-override-server-data"
    runtime_override_xdg = run / "runtime-override-server-xdg"
    runtime_override = runtime_override_data / "runtime.json"
    runtime_override_server = None

    def explicit_runtime_override() -> dict:
        nonlocal runtime_override_server
        server_env = clean_env(
            {"XDG_DATA_HOME": str(runtime_override_xdg), "ALCORDESIGN_APP_DIR": str(app)}
        )
        runtime_override_server, log_path = start_server(
            binary, app, runtime_override_data, server_env, run, "runtime-override-server"
        )
        processes.append(runtime_override_server)
        port = wait_runtime(runtime_override_server, runtime_override)
        no_default = run / "empty-default-xdg"
        explicit_env = clean_env(
            {
                "XDG_DATA_HOME": str(no_default),
                "ALCORDESIGN_RUNTIME": str(runtime_override),
                "ALCORDESIGN_APP_DIR": str(app),
            }
        )
        status = one_shot_status(binary, explicit_env)
        if status["url"] != f"http://127.0.0.1:{port}":
            raise AssertionError("explicit runtime did not override the empty default path")
        assert not (no_default / "AlcorDesign" / "runtime.json").exists(), (
            "test unexpectedly created an implicit runtime"
        )
        code = stop_server(runtime_override_server)
        runtime_override_server = None
        assert code == 0, "explicit-runtime target server did not stop gracefully"
        return {
            "explicit_runtime": str(runtime_override),
            "empty_default_data": str(no_default),
            "port": port,
            "server_log": str(log_path),
            "graceful_exit": code,
        }

    record("ALCORDESIGN_RUNTIME client override", explicit_runtime_override)
    if runtime_override_server is not None:
        code = stop_server(runtime_override_server)
        if code != 0:
            failures.append(f"cleanup of owned runtime-override server returned {code}")
        runtime_override_server = None

    # ALCORDESIGN_DATA_DIR is the shared default for server and client.
    env_data = run / "env-data"
    env_data_runtime = env_data / "runtime.json"
    env_override = clean_env(
        {
            "XDG_DATA_HOME": str(run / "lower-priority-xdg"),
            "ALCORDESIGN_DATA_DIR": str(env_data),
            "ALCORDESIGN_APP_DIR": str(app),
        }
    )
    env_server = None

    def data_env_precedence() -> dict:
        nonlocal env_server
        env_server, log_path = start_server(binary, app, None, env_override, run, "env-data-server")
        processes.append(env_server)
        port = wait_runtime(env_server, env_data_runtime)
        status = one_shot_status(binary, env_override)
        assert status["url"] == f"http://127.0.0.1:{port}", (
            "client did not resolve ALCORDESIGN_DATA_DIR ahead of XDG"
        )
        assert not (run / "lower-priority-xdg" / "AlcorDesign" / "runtime.json").exists(), (
            "server wrote runtime to lower-priority XDG location"
        )
        code = stop_server(env_server)
        env_server = None
        assert code == 0, "env-data server did not stop gracefully"
        return {
            "selected_data_root": str(env_data),
            "lower_priority_xdg": str(run / "lower-priority-xdg"),
            "port": port,
            "server_log": str(log_path),
            "graceful_exit": code,
        }

    record("ALCORDESIGN_DATA_DIR server and client selection", data_env_precedence)
    if env_server is not None:
        code = stop_server(env_server)
        if code != 0:
            failures.append(f"cleanup of owned env-data server returned {code}")
        env_server = None

    # The explicit CLI argument must override ALCORDESIGN_DATA_DIR for the
    # server, while the client can safely target the resulting local runtime.
    cli_data = run / "cli-data"
    overridden_env_data = run / "overridden-env-data"
    cli_runtime = cli_data / "runtime.json"
    cli_env = clean_env(
        {
            "XDG_DATA_HOME": str(run / "cli-lower-priority-xdg"),
            "ALCORDESIGN_DATA_DIR": str(overridden_env_data),
            "ALCORDESIGN_APP_DIR": str(app),
        }
    )
    cli_server = None

    def explicit_data_precedence() -> dict:
        nonlocal cli_server
        cli_server, log_path = start_server(binary, app, cli_data, cli_env, run, "cli-data-server")
        processes.append(cli_server)
        port = wait_runtime(cli_server, cli_runtime)
        assert not overridden_env_data.exists(), (
            "server created the lower-priority ALCORDESIGN_DATA_DIR"
        )
        client_env = clean_env(
            {
                "XDG_DATA_HOME": str(run / "client-empty-xdg"),
                "ALCORDESIGN_RUNTIME": str(cli_runtime),
                "ALCORDESIGN_APP_DIR": str(app),
            }
        )
        status = one_shot_status(binary, client_env)
        assert status["url"] == f"http://127.0.0.1:{port}", (
            "explicit runtime could not reach --data server"
        )
        code = stop_server(cli_server)
        cli_server = None
        assert code == 0, "--data server did not stop gracefully"
        return {
            "cli_data": str(cli_data),
            "overridden_env_data": str(overridden_env_data),
            "port": port,
            "server_log": str(log_path),
            "graceful_exit": code,
        }

    record("serve --data takes precedence over ALCORDESIGN_DATA_DIR", explicit_data_precedence)
    if cli_server is not None:
        code = stop_server(cli_server)
        if code != 0:
            failures.append(f"cleanup of owned --data server returned {code}")
        cli_server = None

    # With both HOME and XDG absent there is no implicit /tmp location. This
    # must fail before any HTTP attempt rather than silently selecting a temp
    # directory. Output is deliberately not copied into the report.
    def no_temp_fallback() -> dict:
        env = clean_env({"ALCORDESIGN_APP_DIR": str(app)})
        result = subprocess.run(
            [str(binary), "call", "design_status", "{}"],
            text=True,
            encoding="utf-8",
            capture_output=True,
            env=env,
            timeout=12,
            check=False,
        )
        diagnostic = (result.stderr + result.stdout).lower()
        assert result.returncode != 0, (
            "design_status unexpectedly succeeded without a data/runtime path"
        )
        assert "no persistent data directory" in diagnostic, (
            "missing HOME/XDG did not fail with the explicit persistent-path diagnostic"
        )
        assert "token" not in diagnostic and "authorization" not in diagnostic, (
            "missing-path diagnostic unexpectedly contains credential material"
        )
        return {
            "exit_code": result.returncode,
            "expected_error": "No persistent data directory",
            "home_set": False,
            "xdg_data_home_set": False,
            "localappdata_set": False,
            "runtime_override_set": False,
        }

    record("no HOME/XDG does not fall back to temporary storage", no_temp_fallback)

    # Ensure every process created by this runner has reached a terminal state.
    for process in processes:
        if process.poll() is None:
            code = stop_server(process)
            if code != 0:
                failures.append(f"owned server PID {process.pid} exited {code} during cleanup")

    summary["created_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    summary["schema"] = "alcordesign.persistent-runtime-acceptance.v1"
    summary["status"] = "FAIL" if failures else "PASS"
    summary["scope"] = (
        "isolated Linux Rust server and MCP client; local synthetic HTML; loopback only"
    )
    summary["failures"] = failures
    report_path = evidence_dir / "report.json"
    report_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    report_path.chmod(0o600)
    print(
        json.dumps(
            {
                "status": summary["status"],
                "run_dir": str(run),
                "report": str(report_path),
                "checks": [{"name": c["name"], "status": c["status"]} for c in checks],
                "failures": failures,
            },
            indent=2,
        )
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
