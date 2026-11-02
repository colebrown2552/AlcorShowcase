"""End-to-end demo of AlcorDesign on a bundled sample page, fully offline.

It starts a private server on a free loopback port with a throwaway data directory,
imports demo/sample/index.html, renders it in Chromium, applies a text edit and a style
edit, undoes the style edit, exports the project as an HTML ZIP and as JSON, and then
stops the server. Each step prints PASS, FAIL or SKIP. The port is never printed.

Usage:
    python demo/run_demo.py [--binary PATH] [--keep]

Without --binary the demo runs `cargo build` and uses the debug binary. Rendering needs
Node with Playwright (set ALCORDESIGN_PLAYWRIGHT to its index.mjs if it is not installed
in renderer/) and Chrome or Chromium (set ALCORDESIGN_CHROME to use a specific one).
When no browser can start, the render, edit and undo steps are reported as SKIP.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "demo" / "sample" / "index.html"
NEW_HEADLINE = "Fresh loaves every morning"
NEW_COLOR = "#c0392b"
NEW_COLOR_RGB = "rgb(192, 57, 43)"
BROWSER_ERRORS = ("playwright", "chromium", "executable", "browser", "renderer")


def redact(text: str) -> str:
    """Hide loopback ports in anything the demo prints."""
    return re.sub(r"(127\.0\.0\.1|localhost):\d+", r"\1:<port>", str(text))


class Results:
    """Collects one line per step and prints it as soon as the step ends."""

    def __init__(self) -> None:
        self.failed = False

    def report(self, step: str, state: str, detail: str = "") -> None:
        self.failed |= state == "FAIL"
        suffix = f" - {redact(detail)}" if detail else ""
        print(f"[{state}] {step}{suffix}", flush=True)


class Server:
    """A running alcor-design server and an authenticated client for its API."""

    def __init__(self, binary: Path, data: Path) -> None:
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("ALCORDESIGN_")
            or key in {"ALCORDESIGN_PLAYWRIGHT", "ALCORDESIGN_CHROME", "ALCORDESIGN_NODE"}
        }
        env["ALCORDESIGN_APP_DIR"] = str(ROOT)
        self.log_path = data.parent / "server.log"
        self.log = self.log_path.open("wb")
        self.process = subprocess.Popen(
            [str(binary), "serve", "--port", "0", "--data", str(data)],
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=self.log,
            stderr=subprocess.STDOUT,
        )
        runtime_file = data / "runtime.json"
        deadline = time.monotonic() + 30
        while True:
            if self.process.poll() is not None:
                raise RuntimeError(f"server exited early: {self.log_tail()}")
            try:
                runtime = json.loads(runtime_file.read_text(encoding="utf-8"))
                if runtime.get("pid") == self.process.pid:
                    break
            except (OSError, ValueError):
                pass
            if time.monotonic() > deadline:
                raise RuntimeError("server did not write runtime.json within 30 seconds")
            time.sleep(0.2)
        self.base = f"http://127.0.0.1:{runtime['port']}"
        self.token = runtime["token"]

    def log_tail(self) -> str:
        self.log.flush()
        return redact(self.log_path.read_text(encoding="utf-8", errors="replace")[-800:])

    def request(self, path: str, body: dict | None = None) -> bytes:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data)
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            message = error.read().decode(errors="replace")
            raise RuntimeError(f"HTTP {error.code}: {message[:400]}") from None

    def tool(self, tool_name: str, /, **arguments: object) -> dict:
        body = {"name": tool_name, "arguments": arguments}
        return json.loads(self.request("/api/tools", body))

    def wait_job(self, job_id: str, seconds: int = 300) -> dict:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            job = self.tool("design_get_job", job_id=job_id)
            if job.get("status") != "running":
                return job
            time.sleep(0.5)
        raise RuntimeError("job did not finish in time")

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.log.close()


def build_binary() -> Path:
    """Build the debug binary with cargo and return its path."""
    subprocess.run(["cargo", "build", "--locked", "--quiet"], cwd=ROOT, check=True)
    metadata = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--no-deps"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    target = Path(json.loads(metadata.stdout)["target_directory"])
    suffix = ".exe" if os.name == "nt" else ""
    return target / "debug" / f"alcor-design{suffix}"


def find_node(page: dict, element_id: str) -> dict | None:
    """Return the captured layer whose HTML id attribute is element_id."""
    for node in page.get("nodes", []):
        if node.get("attributes", {}).get("id") == element_id:
            return node
    return None


def run(server: Server, results: Results) -> None:
    html = SAMPLE.read_text(encoding="utf-8")
    try:
        started = server.tool("design_import_html", html=html, name="Juniper Lane demo")
        job = server.wait_job(started["job_id"])
        project_id = started["project_id"]
        project = server.tool("design_get_project", project_id=project_id)
        page_id = project["pages"][0]["id"]
        results.report("import sample page", "PASS", f"job {job['status']}")
    except Exception as error:  # noqa: BLE001 - every failure is reported, not raised
        results.report("import sample page", "FAIL", str(error))
        return

    page = server.tool("design_get_page", project_id=project_id, page_id=page_id)
    rendered = False
    if page["status"] == "ready":
        try:
            page = server.tool(
                "design_render_page",
                project_id=project_id,
                page_id=page_id,
                expected_revision=page["revision"],
                width=1280,
                height=800,
            )
            ok = page["status"] == "ready" and page["node_count"] > 0 and page["screenshot"]
            results.report(
                "render in Chromium",
                "PASS" if ok else "FAIL",
                f"{page['node_count']} layers, {page['viewport']['width']}px wide",
            )
            rendered = bool(ok)
        except Exception as error:  # noqa: BLE001
            results.report("render in Chromium", "FAIL", str(error))
    else:
        warning = " ".join(page.get("warnings", []))
        if any(word in warning.lower() for word in BROWSER_ERRORS):
            results.report("render in Chromium", "SKIP", f"no usable browser: {warning[:300]}")
        else:
            results.report("render in Chromium", "FAIL", warning[:300])

    if rendered:
        headline = find_node(page, "headline")
        intro = find_node(page, "intro")
        try:
            page = server.tool(
                "design_update_node",
                project_id=project_id,
                page_id=page_id,
                expected_revision=page["revision"],
                selector=headline["selector"],
                text=NEW_HEADLINE,
            )
            ok = find_node(page, "headline")["text"] == NEW_HEADLINE
            results.report("text edit", "PASS" if ok else "FAIL", f"headline -> {NEW_HEADLINE!r}")
            page = server.tool(
                "design_update_node",
                project_id=project_id,
                page_id=page_id,
                expected_revision=page["revision"],
                selector=intro["selector"],
                styles={"color": NEW_COLOR},
            )
            color = find_node(page, "intro")["styles"]["color"]
            ok = color == NEW_COLOR_RGB
            results.report("style edit", "PASS" if ok else "FAIL", f"intro color -> {color}")
            stale = page["revision"] - 1
            try:
                server.tool(
                    "design_undo", project_id=project_id, page_id=page_id, expected_revision=stale
                )
                results.report("stale revision refused", "FAIL", "an outdated edit was accepted")
            except RuntimeError as error:
                ok = "HTTP 409" in str(error)
                results.report("stale revision refused", "PASS" if ok else "FAIL", "HTTP 409")
            page = server.tool(
                "design_undo",
                project_id=project_id,
                page_id=page_id,
                expected_revision=page["revision"],
            )
            color = find_node(page, "intro")["styles"]["color"]
            text = find_node(page, "headline")["text"]
            ok = color != NEW_COLOR_RGB and text == NEW_HEADLINE and page["can_undo"]
            results.report(
                "undo once", "PASS" if ok else "FAIL", f"intro color {color}, headline kept"
            )
        except Exception as error:  # noqa: BLE001
            results.report("edit and undo", "FAIL", str(error))
    else:
        for step in ("text edit", "style edit", "undo once"):
            results.report(step, "SKIP", "needs a rendered page")

    for fmt in ("html", "json"):
        try:
            exported = server.tool("design_export", project_id=project_id, format=fmt)
            payload = server.request(exported["url"])
            if fmt == "html":
                with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                    names = archive.namelist()
                    pages = [archive.read(n).decode() for n in names if n.endswith(".html")]
                ok = "manifest.json" in names and (
                    not rendered or any(NEW_HEADLINE in p for p in pages)
                )
                detail = f"{len(payload)} bytes, {len(names)} files"
            else:
                document = json.loads(payload)
                ok = document["id"] == project_id and len(document["pages"]) == 1
                detail = f"{len(payload)} bytes, {len(document['pages'])} page"
            results.report(f"export {fmt.upper()}", "PASS" if ok else "FAIL", detail)
        except Exception as error:  # noqa: BLE001
            results.report(f"export {fmt.upper()}", "FAIL", str(error))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--binary", type=Path, help="prebuilt alcor-design executable")
    parser.add_argument("--keep", action="store_true", help="keep the temporary data directory")
    args = parser.parse_args()
    results = Results()
    try:
        binary = args.binary.resolve() if args.binary else build_binary()
        results.report("locate binary", "PASS", binary.name)
    except Exception as error:  # noqa: BLE001
        results.report("locate binary", "FAIL", str(error))
        return 1
    scratch = Path(tempfile.mkdtemp(prefix="alcordesign-demo-"))
    server = None
    try:
        server = Server(binary, scratch / "data")
        status = server.tool("design_status")
        results.report("start server", "PASS", f"loopback only, {status['project_count']} projects")
        run(server, results)
    except Exception as error:  # noqa: BLE001
        results.report("start server", "FAIL", str(error))
    finally:
        if server:
            server.stop()
            stopped = server.process.poll() is not None
            results.report("stop server", "PASS" if stopped else "FAIL")
            if results.failed:
                print("server log tail:", server.log_tail())
        if args.keep:
            print(f"data kept in {scratch}")
        else:
            shutil.rmtree(scratch, ignore_errors=True)
    print("RESULT:", "FAIL" if results.failed else "PASS")
    return 1 if results.failed else 0


if __name__ == "__main__":
    sys.exit(main())
