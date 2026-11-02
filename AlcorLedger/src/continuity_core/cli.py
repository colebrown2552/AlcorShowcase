"""Command-line interface for continuity-core.

Verbs: ``init`` lays out the default ledgers, ``append`` adds one validated entry, ``list`` streams
entries, ``verify`` checks chains and policy, and ``scan`` looks for private data in files.

Exit codes are 0 for success, 1 when a check ran and failed (``verify`` found damage, ``scan``
found data), and 2 for errors such as a rejected entry or an unreadable file. Output is one JSON
object per line so it can be piped into other tools.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .ledger import JsonlLedger, LedgerError
from .redaction import scan_paths

# The ledgers ``init`` creates, and the entry kind each one is meant to hold.
LEDGER_LAYOUT = {
    "memory/public.jsonl": "memory",
    "memory/observations.jsonl": "observation",
    "memory/decisions.jsonl": "decision",
    "wishlist/public.jsonl": "wishlist",
}

_PROVENANCE_CHOICES = ["analysis", "imported", "operator", "runtime", "test"]


def _json_dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _cmd_init(args: argparse.Namespace) -> int:
    root = Path(args.root)
    created: list[str] = []
    for relative_path in LEDGER_LAYOUT:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.touch()
            created.append(str(path))
    # Private working data belongs here, outside what gets published.
    local = root / ".local-state"
    local.mkdir(parents=True, exist_ok=True)
    marker = local / "README.txt"
    if not marker.exists():
        marker.write_text(
            "Local-only state. This directory must remain excluded from version control.\n",
            encoding="utf-8",
        )
        created.append(str(marker))
    print(_json_dump({"ok": True, "created": created}))
    return 0


def _cmd_append(args: argparse.Namespace) -> int:
    provenance: dict[str, str] = {"type": args.provenance}
    if args.reference:
        provenance["reference"] = args.reference
    source: dict[str, Any] = {
        "kind": args.kind,
        "statement": args.statement,
        "confidence": args.confidence,
        "provenance": provenance,
        "tags": args.tag or [],
        "supersedes": args.supersedes or [],
    }
    if args.status:
        source["status"] = args.status
    if args.id:
        source["id"] = args.id
    if args.expires_at:
        source["expires_at"] = args.expires_at
    if args.metadata:
        source["metadata"] = json.loads(args.metadata)
    entry = JsonlLedger(args.ledger).append(source, redact=args.redact)
    print(_json_dump(entry))
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    ledger = JsonlLedger(args.ledger)
    for printed, entry in enumerate(ledger.query(kind=args.kind, status=args.status, tag=args.tag)):
        # Check the limit before printing so that --limit 0 prints nothing.
        if args.limit is not None and printed >= args.limit:
            break
        print(_json_dump(entry))
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    failed = False
    for path in args.ledger:
        report = JsonlLedger(path).verify()
        print(_json_dump(report.as_dict()))
        failed = failed or not report.ok
    return 1 if failed else 0


def _cmd_scan(args: argparse.Namespace) -> int:
    failed = False
    skipped: list[dict[str, str]] = []
    for raw_path in args.path:
        if not Path(raw_path).exists():
            failed = True
            print(_json_dump({"path": raw_path, "error": "path-does-not-exist"}), file=sys.stderr)
    for result in scan_paths(args.path, max_bytes=args.max_bytes):
        if result.skipped:
            # A skipped file was not inspected. It only fails the run under --strict, because
            # binary assets are normal in a tree but must not hide behind a green result.
            if args.strict:
                failed = True
            skipped.append({"path": result.path, "reason": result.reason or "unknown"})
            continue
        for finding in result.findings:
            failed = True
            print(_json_dump({"path": result.path, "finding": finding.as_dict()}))
    if skipped:
        print(_json_dump({"skipped": skipped}), file=sys.stderr)
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser with every verb attached."""
    parser = argparse.ArgumentParser(
        prog="continuity",
        description="Privacy-first, tamper-evident public memory and wishlist ledgers.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="create a safe public/local state layout")
    init_parser.add_argument("root", nargs="?", default=".")
    init_parser.set_defaults(func=_cmd_init)

    append_parser = subparsers.add_parser("append", help="append one validated entry")
    append_parser.add_argument("ledger")
    append_parser.add_argument("--kind", required=True, choices=sorted(set(LEDGER_LAYOUT.values())))
    append_parser.add_argument("--statement", required=True)
    append_parser.add_argument("--status")
    append_parser.add_argument("--confidence", type=float, default=0.5)
    append_parser.add_argument("--provenance", default="analysis", choices=_PROVENANCE_CHOICES)
    append_parser.add_argument("--reference")
    append_parser.add_argument("--tag", action="append")
    append_parser.add_argument("--supersedes", action="append")
    append_parser.add_argument("--id")
    append_parser.add_argument("--expires-at")
    append_parser.add_argument("--metadata", help="JSON object")
    append_parser.add_argument(
        "--redact", action="store_true", help="replace blocked data instead of rejecting it"
    )
    append_parser.set_defaults(func=_cmd_append)

    list_parser = subparsers.add_parser("list", help="stream matching entries")
    list_parser.add_argument("ledger")
    list_parser.add_argument("--kind")
    list_parser.add_argument("--status")
    list_parser.add_argument("--tag")
    list_parser.add_argument("--limit", type=int)
    list_parser.set_defaults(func=_cmd_list)

    verify_parser = subparsers.add_parser(
        "verify", help="verify schemas, privacy gate, and hash chains"
    )
    verify_parser.add_argument("ledger", nargs="+")
    verify_parser.set_defaults(func=_cmd_verify)

    scan_parser = subparsers.add_parser(
        "scan", help="scan selected files or directories without echoing matched data"
    )
    scan_parser.add_argument("path", nargs="+")
    scan_parser.add_argument("--max-bytes", type=int, default=2_000_000)
    scan_parser.add_argument(
        "--strict", action="store_true", help="treat unsupported or unreadable files as failures"
    )
    scan_parser.set_defaults(func=_cmd_scan)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command line and return the process exit code.

    Args:
        argv: Arguments without the program name. Defaults to ``sys.argv[1:]``.

    Returns:
        0 on success, 1 when a verify or scan check failed, 2 on an error.
    """
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (LedgerError, json.JSONDecodeError, OSError) as exc:
        error = {"ok": False, "error": str(exc), "type": type(exc).__name__}
        print(_json_dump(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
