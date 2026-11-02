"""Check every saved page's PNG against its recorded canvas dimensions.

Usage:

    python site_capture_acceptance.py PROJECT_ID [--data DATA]

PROJECT_ID is the 32-character id of an imported project whose pages have all
finished rendering. DATA defaults to ALCORDESIGN_DATA_DIR, or the per-user
AlcorDesign data folder. A summary is written to DATA/all-pages-acceptance.json.
"""

import argparse
import json
import os
import struct
from pathlib import Path


def default_data():
    root = (
        os.environ.get("LOCALAPPDATA")
        or os.environ.get("XDG_DATA_HOME")
        or str(Path.home() / ".local" / "share")
    )
    return Path(os.environ.get("ALCORDESIGN_DATA_DIR") or Path(root) / "AlcorDesign")


parser = argparse.ArgumentParser()
parser.add_argument("project_id")
parser.add_argument("--data", type=Path, default=default_data())
args = parser.parse_args()
assert len(args.project_id) == 32 and all(c in "0123456789abcdef" for c in args.project_id)
data = args.data
project = json.loads(
    (data / "projects" / args.project_id / "project.json").read_text(encoding="utf-8")
)
rows = []
for page in project["pages"]:
    assert page["status"] == "ready", (page["url"], page["status"])
    file = (data / page["screenshot"].removeprefix("/files/")).resolve()
    assert file.is_relative_to(data.resolve())
    with file.open("rb") as stream:
        header = stream.read(24)
    assert header[:8] == b"\x89PNG\r\n\x1a\n"
    size = struct.unpack(">II", header[16:24])
    assert size == (page["viewport"]["width"], page["viewport"]["height"]), (
        page["url"],
        size,
        page["viewport"],
    )
    assert page["nodes"] and page["html"]
    rows.append(
        {
            "url": page["url"],
            "width": size[0],
            "height": size[1],
            "layers": len(page["nodes"]),
            "revision": page["revision"],
            "warnings": page["warnings"],
        }
    )
assert len(rows) == project["source"].get("discovery", {}).get("count", len(rows))
result = {
    "ok": True,
    "project_id": args.project_id,
    "pages": len(rows),
    "layers": sum(row["layers"] for row in rows),
    "source_sha": project["source"].get("sha"),
    "max_height": max(row["height"] for row in rows),
    "rows": rows,
}
(data / "all-pages-acceptance.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({key: value for key, value in result.items() if key != "rows"}))
