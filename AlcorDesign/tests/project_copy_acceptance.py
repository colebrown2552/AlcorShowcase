#!/usr/bin/env python3
"""Check `alcor-design copy-project` on synthetic projects.

The offline copy must publish a complete, hash-identical project tree, refuse
symlinks, changed snapshots and unknown or tampered targets, resume an
interrupted copy, and be excluded while a server holds the data directory.

Usage (Linux):

    python project_copy_acceptance.py OUTPUT_DIR --binary target/debug/alcor-design

OUTPUT_DIR is a scratch folder for the per-run data and report.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from persistent_runtime_acceptance import (
    clean_env,
    start_server,
    stop_server,
    tool_http,
    wait_runtime,
)

app = Path(__file__).resolve().parents[1]
cli = argparse.ArgumentParser()
cli.add_argument("output_dir", type=Path)
cli.add_argument("--binary", type=Path, default=app / "target/debug/alcor-design")
options = cli.parse_args()
binary = options.binary.resolve(strict=True)
out_root = options.output_dir.resolve()
out_root.mkdir(parents=True, exist_ok=True, mode=0o700)
run = Path(tempfile.mkdtemp(prefix="copy-", dir=out_root))
data = run / "data"
projects = data / "projects"
projects.mkdir(parents=True)
source = run / "source"
source.mkdir()
identity = "0123456789abcdef0123456789abcdef"
existing_id = "fedcba9876543210fedcba9876543210"
project = {
    "id": identity,
    "name": "Synthetic copy",
    "source": {},
    "revision": 1,
    "created": 1,
    "job_id": None,
    "pages": [
        {
            "id": "page",
            "title": "Example",
            "url": "https://example.test",
            "status": "ready",
            "viewport": {},
            "screenshot": "/files/projects/" + identity + "/capture/image.png",
            "revision": 1,
            "comments": [{"text": "retained"}],
            "html": "<p>retained</p>",
        }
    ],
}
(source / "project.json").write_text(json.dumps(project), encoding="utf-8")
(source / "capture").mkdir()
(source / "capture" / "image.png").write_bytes(b"synthetic image bytes")
(source / "capture" / "empty").mkdir()
existing = projects / existing_id
existing.mkdir()
(existing / "project.json").write_text(
    json.dumps(dict(project, id=existing_id, name="Existing")), encoding="utf-8"
)
existing_hash = hashlib.sha256((existing / "project.json").read_bytes()).hexdigest()


def digest_tree(root):
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob("*")
        if p.is_file()
    }


def copy(s):
    return subprocess.run(
        [str(binary), "copy-project", "--source-snapshot", str(s), "--data", str(data)],
        capture_output=True,
        text=True,
        timeout=30,
    )


before = digest_tree(source)
bad = run / "symlink-source"
bad.mkdir()
(bad / "project.json").write_text(
    json.dumps(dict(project, id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")), encoding="utf-8"
)
(bad / "linked").symlink_to(source / "capture" / "image.png")
assert copy(bad).returncode != 0
assert not (projects / "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").exists()
first = copy(source)
assert first.returncode == 0, first.stderr
receipt = json.loads(first.stdout)
target = projects / identity
assert (
    receipt["project_id"] == identity
    and receipt["files"] == 2
    and receipt["directories"] == 2
    and receipt["page_count"] == 1
)
assert before == digest_tree(source) == digest_tree(target)
assert (target / "capture" / "empty").is_dir()
second = copy(source)
assert second.returncode == 0 and json.loads(second.stdout)["already_complete"]
assert digest_tree(target) == before
different = run / "different"
shutil.copytree(source, different)
(different / "capture" / "image.png").write_bytes(b"changed synthetic file")
assert copy(different).returncode != 0 and digest_tree(target) == before
unknown_id = "cccccccccccccccccccccccccccccccc"
unknown_src = run / "unknown-source"
unknown_src.mkdir()
(unknown_src / "project.json").write_text(
    json.dumps(dict(project, id=unknown_id)), encoding="utf-8"
)
unknown = projects / unknown_id
unknown.mkdir()
(unknown / "sentinel").write_bytes(b"do not touch")
assert copy(unknown_src).returncode != 0 and (unknown / "sentinel").read_bytes() == b"do not touch"
stage_id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
stage_src = run / "unknown-stage-source"
stage_src.mkdir()
(stage_src / "project.json").write_text(json.dumps(dict(project, id=stage_id)), encoding="utf-8")
unknown_stage = data / ".project-copy" / stage_id
unknown_stage.mkdir()
(unknown_stage / "sentinel").write_bytes(b"preserve staging")
assert (
    copy(stage_src).returncode != 0
    and (unknown_stage / "sentinel").read_bytes() == b"preserve staging"
)
assert not (projects / stage_id).exists()
assert hashlib.sha256((existing / "project.json").read_bytes()).hexdigest() == existing_hash
recovery_id = "dddddddddddddddddddddddddddddddd"
recovery_src = run / "recovery-source"
recovery_src.mkdir()
(recovery_src / "project.json").write_text(
    json.dumps(dict(project, id=recovery_id)), encoding="utf-8"
)
(recovery_src / "a.bin").write_bytes(b"a" * 4096)
with (recovery_src / "b.bin").open("wb") as f:
    block = b"b" * (1024 * 1024)
    for _ in range(128):
        f.write(block)
recovery_target = projects / recovery_id
proc = subprocess.Popen(
    [str(binary), "copy-project", "--source-snapshot", str(recovery_src), "--data", str(data)],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
deadline = time.monotonic() + 40
try:
    while (
        time.monotonic() < deadline
        and proc.poll() is None
        and not (recovery_target / "a.bin").is_file()
    ):
        time.sleep(0.002)
    if not (recovery_target / "a.bin").is_file() or proc.poll() is not None:
        raise AssertionError("Could not interrupt copy after first published file")
    proc.kill()
    proc.communicate(timeout=10)
    assert not (recovery_target / "project.json").exists()
finally:
    if proc.poll() is None:
        proc.kill()
        proc.communicate(timeout=10)
(recovery_target / "a.bin").write_bytes(b"tampered")
assert (
    copy(recovery_src).returncode != 0 and (recovery_target / "a.bin").read_bytes() == b"tampered"
)
(recovery_target / "a.bin").write_bytes(b"a" * 4096)
resumed = copy(recovery_src)
assert resumed.returncode == 0, resumed.stderr
assert digest_tree(recovery_src) == digest_tree(recovery_target)
assert json.loads(copy(recovery_src).stdout)["already_complete"]
env = clean_env({"ALCORDESIGN_APP_DIR": str(app), "NO_PROXY": "*", "no_proxy": "*"})
server = None
try:
    server, log = start_server(binary, app, data, env, run, "server")
    wait_runtime(server, data / "runtime.json")
    result = tool_http(data / "runtime.json", "design_list_projects", {})
    summaries = {p["id"]: p for p in result["projects"]}
    assert (
        set(summaries) == {identity, existing_id, recovery_id}
        and summaries[identity]["page_count"] == 1
    )
    other = run / "other"
    other.mkdir()
    (other / "project.json").write_text(
        json.dumps(dict(project, id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")), encoding="utf-8"
    )
    locked = copy(other)
    assert locked.returncode != 0 and "already holds" in locked.stderr
    assert not (projects / "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").exists()
finally:
    if server is not None:
        stop_server(server)
report = {
    "schema": "alcordesign.project-copy.acceptance.v1",
    "status": "PASS",
    "checks": [
        "complete_tree_hashes",
        "empty_directory",
        "existing_project_preserved",
        "completed_reconcile",
        "different_snapshot_refused",
        "unknown_target_untouched",
        "unknown_stage_untouched",
        "symlink_refused",
        "tampered_partial_refused",
        "interrupted_copy_resumed",
        "real_server_lists_projects",
        "active_server_lock_excludes_copy",
    ],
    "copy_receipt": receipt,
    "run": str(run),
}
(run / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, separators=(",", ":")))
