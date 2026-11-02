"""Publish this build as an update channel: a folder of files plus a manifest of their hashes.

The channel it writes is what a broker's ``update_channel`` setting (a folder path, or an https URL
serving the same folder) points at::

    python scripts/publish.py --out /path/to/channel --note "what changed"

``version.json`` lists every ``extension/`` and ``runtime/`` file with its SHA-256 and size, plus a
build id that changes whenever any extension file changes. A broker that polls the channel
verifies each file against that list before it installs anything. See
``runtime/update_channel.py`` for the format and for what the checks do and do not prove.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime"))

import update_channel  # noqa: E402  (needs the path line above)


def main(argv: list[str] | None = None) -> int:
    """Publish a channel; prints a one-line JSON summary and returns the exit code."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--source", type=Path, default=ROOT, help="folder with extension/ and runtime/"
    )
    parser.add_argument(
        "--out", type=Path, required=True, help="channel folder to create or refresh"
    )
    parser.add_argument("--note", action="append", default=[], help="release note (repeatable)")
    args = parser.parse_args(argv)
    try:
        manifest = update_channel.publish(args.source, args.out, args.note)
    except update_channel.ChannelError as exc:
        print(f"cannot publish: {exc}", file=sys.stderr)
        return 2
    summary = {
        "version": manifest.version,
        "build": manifest.build[:12],
        "files": len(manifest.files),
        "published": manifest.published,
    }
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
