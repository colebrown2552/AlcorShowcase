"""Exercise persistent page comments against a running AlcorDesign server.

Start the server first (`alcor-design serve --data DATA`), then run:

    python comments_acceptance.py [--data DATA]

The port and token are read from DATA/runtime.json. DATA defaults to
ALCORDESIGN_DATA_DIR, or the per-user AlcorDesign data folder.
"""

import argparse
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path


def default_data():
    root = (
        os.environ.get("LOCALAPPDATA")
        or os.environ.get("XDG_DATA_HOME")
        or str(Path.home() / ".local" / "share")
    )
    return Path(os.environ.get("ALCORDESIGN_DATA_DIR") or Path(root) / "AlcorDesign")


parser = argparse.ArgumentParser()
parser.add_argument("--data", type=Path, default=default_data())
data = parser.parse_args().data
runtime = json.loads((data / "runtime.json").read_text(encoding="utf-8-sig"))
base = "http://127.0.0.1:" + str(runtime["port"])


def tool(tool_name, **arguments):
    request = urllib.request.Request(
        base + "/api/tools",
        data=json.dumps({"name": tool_name, "arguments": arguments}).encode(),
        headers={"Authorization": "Bearer " + runtime["token"], "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


checks = []
project = tool(
    "design_import_html",
    name="Comment acceptance",
    html=(
        "<html><title>Comment acceptance</title>"
        '<body style="margin:0;background:#172022;color:white;min-height:2200px">'
        '<h1 style="padding:60px">Design review</h1>'
        '<section style="margin-top:1400px">Below the fold</section></body></html>'
    ),
    base_url="https://www.example.com/",
)
deadline = time.monotonic() + 240
while time.monotonic() < deadline:
    job = tool("design_get_job", job_id=project["job_id"])
    if job["status"] in ("completed", "failed", "partial"):
        assert job["status"] == "completed", job
        break
    time.sleep(1)
else:
    raise AssertionError("Comment fixture import timed out")
page = tool("design_get_project", project_id=project["project_id"])["pages"][0]
pair = dict(project_id=project["project_id"], page_id=page["id"])
created = tool(
    "design_add_comment",
    **pair,
    x=240.5,
    y=1610.25,
    body="Move this section above the fold.",
    author="Review fixture",
)
comment = created["comment"]
assert comment["x"] == 240.5 and comment["y"] == 1610.25 and not comment["resolved"]
checks.append("world-coordinate pin below first viewport")
thread = dict(pair, comment_id=comment["id"])
reply = tool(
    "design_reply_comment", **thread, body="I will adjust the layout.", author="Assistant fixture"
)["comment"]
assert len(reply["replies"]) == 1 and reply["replies"][0]["author"] == "Assistant fixture"
checks.append("persistent threaded reply")
assert tool("design_resolve_comment", **thread, resolved=True)["comment"]["resolved"] is True
assert tool("design_resolve_comment", **thread, resolved=False)["comment"]["resolved"] is False
checks.append("resolve and reopen")
with concurrent.futures.ThreadPoolExecutor() as executor:
    render = executor.submit(
        tool,
        "design_render_page",
        **pair,
        width=1440,
        height=1000,
        expected_revision=page["revision"],
    )
    time.sleep(0.2)
    tool(
        "design_reply_comment",
        **thread,
        body="This reply arrives while pixels render.",
        author="Review fixture",
    )
    updated = render.result()
assert len(updated["comments"]) == 1
comments = tool("design_list_comments", **pair)["comments"]
assert len(comments[0]["replies"]) == 2
checks.append("concurrent render preserves comments")
stored = json.loads((data / "projects" / project["project_id"] / "project.json").read_text())
assert stored["pages"][0]["comments"] == comments
checks.append("comments durably saved with project")
for args in (
    {"x": -1, "y": 50, "body": "invalid"},
    {"x": 10, "y": 999999, "body": "invalid"},
    {"x": 10, "y": 50, "body": "   "},
):
    try:
        tool("design_add_comment", **pair, **args)
    except urllib.error.HTTPError as error:
        assert error.code == 400
    else:
        raise AssertionError("Invalid pin accepted")
checks.append("invalid and empty pins rejected")
try:
    tool("design_render_page", **pair, width=1440, height=1000, expected_revision=page["revision"])
except urllib.error.HTTPError as error:
    assert "Revision conflict" in error.read().decode()
else:
    raise AssertionError("Stale page mutation accepted")
checks.append("stale visual revision rejected")
assert tool("design_delete_comment", **thread)["comments"] == []
assert tool("design_list_comments", **pair)["comments"] == []
checks.append("thread deletion persists")
receipt = {"ok": True, "project_id": project["project_id"], "checks": checks}
(data / "comments-acceptance.json").write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt))
