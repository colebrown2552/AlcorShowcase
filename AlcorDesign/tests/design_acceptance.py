"""End-to-end check of a running AlcorDesign server with a synthetic design.

Imports one local HTML fixture, then checks authentication, rendering, text and
CSS edits, undo/redo, layer insert/remove, responsive re-render, exports and
saved state. GitHub source browsing is checked when the server has it enabled
and checked to be refused when it does not.

Usage: start the server (`alcor-design serve`), then

    python tests/design_acceptance.py [--runtime PATH/runtime.json] [--exe BINARY]

--runtime defaults to ALCORDESIGN_RUNTIME, or runtime.json in the data
directory (ALCORDESIGN_DATA_DIR, else the per-user AlcorDesign folder). With
--exe, a second server is also started on an isolated copy of the project to
check restart persistence.
"""

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

FIXTURE = """<!doctype html><html><head><title>AlcorDesign acceptance</title>
<style>html,body{margin:0;background:#10141d;color:#f0f4ff;font-family:Arial}
main{box-sizing:border-box;max-width:1000px;padding:32px;margin:auto}
h1{font-size:48px;color:rgb(100,200,250)}.panel{padding:24px;background:#202532}
@media(max-width:500px){main{padding:16px}h1{font-size:30px}}</style></head>
<body><main id="canvas"><h1 id="headline">Original design heading</h1>
<section class="panel"><p>Editable design content</p>
<button onclick="alert('never')">Local button</button>
<input type="password" value="synthetic-private-value"></section></main>
<script>document.querySelector('h1').textContent='Script must not run'</script></body></html>"""


class Client:
    def __init__(self, runtime):
        self.runtime_path = Path(runtime)
        self.runtime = json.loads(self.runtime_path.read_text(encoding="utf-8"))
        self.base = f"http://127.0.0.1:{self.runtime['port']}"

    def request(self, path, body=None, auth=True, headers=None, expected=200):
        request_headers = dict(headers or {})
        if auth:
            request_headers["Authorization"] = "Bearer " + self.runtime["token"]
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            request_headers["Content-Type"] = "application/json"
        request = Request(self.base + path, data=data, headers=request_headers)
        try:
            response = urlopen(request, timeout=180)
        except HTTPError as error:
            response = error
        raw = response.read()
        assert response.status == expected, (
            f"{path} returned {response.status}, expected {expected}: {raw[:250]!r}"
        )
        return raw

    def tool(self, name, arguments=None, expected=200):
        raw = self.request(
            "/api/tools", {"name": name, "arguments": arguments or {}}, expected=expected
        )
        return json.loads(raw)


def png_sha(client, page):
    image = client.request(page["screenshot"])
    assert image[1:4] == b"PNG", "screenshot was not PNG"
    width = int.from_bytes(image[16:20], "big")
    height = int.from_bytes(image[20:24], "big")
    assert width == page["viewport"]["width"]
    assert height == page["viewport"]["height"], "viewport height did not match rendered pixels"
    return hashlib.sha256(image).hexdigest()


def wait_job(client, ident):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        result = client.tool("design_get_job", {"job_id": ident})
        if result["status"] in ("completed", "failed", "partial"):
            assert result["status"] == "completed", result
            return result
        time.sleep(0.25)
    raise AssertionError("Synthetic import exceeded 180 seconds")


def default_runtime():
    explicit = os.environ.get("ALCORDESIGN_RUNTIME")
    if explicit:
        return Path(explicit)
    data = os.environ.get("ALCORDESIGN_DATA_DIR")
    if data:
        return Path(data) / "runtime.json"
    root = (
        os.environ.get("LOCALAPPDATA")
        or os.environ.get("XDG_DATA_HOME")
        or str(Path.home() / ".local" / "share")
    )
    return Path(root) / "AlcorDesign" / "runtime.json"


def persistence_copy(client, project_id, page_id, exe, expected_revision, github):
    """Restart only a new test process against an isolated copy of this fixture."""
    data = client.runtime_path.parent
    with tempfile.TemporaryDirectory(prefix="alcordesign-persistence-") as folder:
        target = Path(folder)
        shutil.copytree(data / "projects" / project_id, target / "projects" / project_id)
        env = os.environ.copy()
        env["ALCORDESIGN_APP_DIR"] = client.runtime["app_dir"]
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        command = [str(exe), "serve", "--port", "0", "--data", str(target)]
        if github:
            command += ["--github", github, "--repo", client.runtime["repo"]]
        process = subprocess.Popen(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env, creationflags=flags
        )
        try:
            deadline = time.monotonic() + 15
            while not (target / "runtime.json").exists() and time.monotonic() < deadline:
                assert process.poll() is None, "Isolated persistence server failed to start"
                time.sleep(0.1)
            restored = Client(target / "runtime.json")
            page = restored.tool("design_get_page", {"project_id": project_id, "page_id": page_id})
            assert page["revision"] == expected_revision
            assert any(node["text"] == "Revised design heading" for node in page["nodes"])
            assert page["status"] == "ready"
            png_sha(restored, page)
            # The running owner's runtime token and port were never touched.
            assert (
                json.loads(client.runtime_path.read_text(encoding="utf-8"))["pid"]
                == client.runtime["pid"]
            )
        finally:
            process.terminate()
            process.wait(timeout=10)
            if process.stderr:
                process.stderr.close()


def run(runtime, exe=None):
    client = Client(runtime)
    checks = []
    status = client.tool("design_status")
    assert status["core"] == "Rust"
    assert status["sha"] == client.runtime["sha"]
    client.request("/api/projects", auth=False, expected=401)
    client.request("/api/projects", headers={"Origin": "https://untrusted.example"}, expected=403)
    client.request("/api/projects", headers={"Host": "untrusted.example"}, expected=403)
    client.request("/files/runtime.json", expected=403)
    client.request("/files/projects/%2e%2e/runtime.json", expected=403)
    checks.append("private API requires auth and rejects foreign Origin, Host and file traversal")

    github = status.get("github_repository")
    if github:
        files = client.tool("design_repo_files", {})
        assert files["sha"] == client.runtime["sha"]
        assert files["files"], "GitHub source inventory missing"
        source_path = files["files"][0]["path"]
        source = client.tool("design_read_source", {"path": source_path})
        assert source["sha"] == client.runtime["sha"]
        committed = subprocess.run(
            ["git", "-C", client.runtime["repo"], "show", f"{source['sha']}:{source_path}"],
            capture_output=True,
            check=True,
        ).stdout.decode("utf-8")
        assert source["content"].replace("\r\n", "\n") == committed.replace("\r\n", "\n"), (
            "Source bytes do not match declared Git SHA"
        )
        for path in ["../.env", "site/../../outside.txt", ".git/config"]:
            assert client.tool("design_read_source", {"path": path}, expected=400).get("error")
        checks.append(
            "GitHub source reads the exact declared commit; traversal and non-site files rejected"
        )
    else:
        refused = client.tool("design_repo_files", {}, expected=400)
        assert "ALCORDESIGN_GITHUB_REPO" in json.dumps(refused)
        checks.append(
            "source tools are refused with a clear error when GitHub browsing is not enabled"
        )

    imported = client.tool(
        "design_import_html", {"name": "Acceptance synthetic design", "html": FIXTURE}
    )
    job = wait_job(client, imported["job_id"])
    assert job["completed"] == 1 and job["failed_pages"] == 0
    project_id = imported["project_id"]
    project = client.tool("design_get_project", {"project_id": project_id})
    assert project["source"]["discovery"]["complete"] is True
    assert project["source"]["discovery"]["count"] == 1
    page_id = project["pages"][0]["id"]
    args = {"project_id": project_id, "page_id": page_id}
    page = client.tool("design_get_page", args)
    assert page["status"] == "ready"
    heading = next(
        node for node in page["nodes"] if node.get("attributes", {}).get("id") == "headline"
    )
    original_selector = heading["selector"]
    assert heading["text"] == "Original design heading"
    assert heading["styles"]["font-size"] == "48px"
    original_png = png_sha(client, page)
    checks.append(
        "HTML import renders real PNG and inspectable DOM layers with script execution disabled"
    )

    page = client.tool(
        "design_update_node",
        {
            **args,
            "selector": original_selector,
            "text": "Revised design heading",
            "styles": {"font-size": "34px", "color": "#ff8844", "translate": "10px 5px"},
        },
    )
    heading = next(node for node in page["nodes"] if node["selector"] == original_selector)
    assert heading["text"] == "Revised design heading"
    assert heading["styles"]["font-size"] == "34px"
    assert "translate: 10px 5px !important" in heading["inline_style"]
    edited_png = png_sha(client, page)
    assert edited_png != original_png, "Text/CSS edit did not change pixels"
    assert page["can_undo"] is True
    client.tool(
        "design_update_node", {**args, "selector": "h1", "text": "Unbound edit"}, expected=400
    )
    client.tool(
        "design_update_node",
        {
            **args,
            "selector": original_selector,
            "styles": {"background": "url(https://example.com/)"},
        },
        expected=400,
    )
    checks.append(
        "layer text/CSS/position edits persist and change pixels; unbound/unsafe edits rejected"
    )

    page = client.tool("design_undo", args)
    assert (
        next(node for node in page["nodes"] if node["selector"] == original_selector)["text"]
        == "Original design heading"
    )
    assert png_sha(client, page) == original_png, "Undo failed to restore exact synthetic pixels"
    assert page["can_redo"] is True
    undone_css = client.tool("design_export", {"project_id": project_id, "format": "css"})
    assert b"34px" not in client.request(undone_css["url"]), "CSS export retained undone styles"
    page = client.tool("design_redo", args)
    assert png_sha(client, page) == edited_png, "Redo failed to restore exact edited pixels"
    checks.append("undo/redo restores exact pixels and CSS export follows active document state")

    page = client.tool(
        "design_insert_node", {**args, "kind": "text", "text": "Newly created design layer"}
    )
    inserted = next(node for node in page["nodes"] if node["text"] == "Newly created design layer")
    assert inserted["tag"] == "p"
    page = client.tool("design_remove_node", {**args, "selector": inserted["selector"]})
    assert not any(node["id"] == inserted["id"] for node in page["nodes"])
    page = client.tool("design_insert_node", {**args, "kind": "rectangle"})
    rectangles = [
        node
        for node in page["nodes"]
        if node["tag"] == "div" and node["width"] == 240 and node["height"] == 160
    ]
    assert rectangles
    page = client.tool("design_remove_node", {**args, "selector": rectangles[-1]["selector"]})
    checks.append("new text and rectangle layers can be created and removed")

    page = client.tool("design_render_page", {**args, "width": 390, "height": 844})
    assert page["viewport"]["width"] == 390
    mobile_png = png_sha(client, page)
    assert mobile_png != edited_png
    assert (
        next(node for node in page["nodes"] if node["selector"] == original_selector)["text"]
        == "Revised design heading"
    )
    checks.append(
        "390px re-render preserves the editable document and gives matching PNG dimensions"
    )

    exported = client.tool("design_export", {"project_id": project_id, "format": "html"})
    archive_bytes = client.request(exported["url"])
    assert len(archive_bytes) == exported["bytes"]
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        assert {f"{page_id}.html", "manifest.json", "README.txt"}.issubset(archive.namelist())
        html = archive.read(f"{page_id}.html").decode()
        assert "Revised design heading" in html
        assert "data-alcor-design-id" in html
        assert (
            "<script" not in html
            and "onclick=" not in html
            and "synthetic-private-value" not in html
        )
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["id"] == project_id
    css_export = client.tool("design_export", {"project_id": project_id, "format": "css"})
    assert b"34px" in client.request(css_export["url"])
    json_export = client.tool("design_export", {"project_id": project_id, "format": "json"})
    document = json.loads(client.request(json_export["url"]))
    assert document["pages"][0]["revision"] == page["revision"]
    disk = json.loads(
        (client.runtime_path.parent / "projects" / project_id / "project.json").read_text(
            encoding="utf-8"
        )
    )
    assert disk["pages"][0]["html"] == document["pages"][0]["html"]
    assert disk["pages"][0]["revision"] == page["revision"]
    checks.append("HTML ZIP, CSS, JSON exports and private saved document preserve final state")

    if exe:
        persistence_copy(client, project_id, page_id, exe, page["revision"], github)
        checks.append(
            "fresh process restores document, layers and pixels from an isolated data copy"
        )

    result = {
        "ok": True,
        "checks": checks,
        "project_id": project_id,
        "page_id": page_id,
        "sha": status["sha"],
        "revision": page["revision"],
        "png_sha256": {"original": original_png, "edited": edited_png, "mobile": mobile_png},
    }
    evidence = client.runtime_path.parent / "acceptance"
    evidence.mkdir(exist_ok=True)
    (evidence / "design-acceptance.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, default=default_runtime())
    parser.add_argument("--exe", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(run(arguments.runtime, arguments.exe), indent=2))
