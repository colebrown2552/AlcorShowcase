"""The release repository: where landed releases are kept and where promotions are recorded.

It plays the part a git remote plays in a git-backed setup:

* ``releases/<commit>/`` holds a release's manifest and files (the objects);
* ``pointer.jsonl`` holds the production pointer history (the branch).

Every pointer entry commits to the one before it by hash, so the log is an audit trail that
cannot be edited quietly: the controller refuses to act on a log whose chain does not verify.
``promote`` and ``rollback`` are both just appends; production is never "set", only pointed.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

from .fsutil import (
    FileLock,
    canonical,
    read_json,
    rename_path,
    sha256_bytes,
    utc_now,
    write_json_atomic,
)
from .release import COMMIT_RE, Release, ReleaseError

POINTER_FILE = "pointer.jsonl"
GENESIS = "0" * 64
# Target value that means "the site as it was before the controller's first release".
INITIAL = "restore-initial"


def short(target: str) -> str:
    """Return the form of a pointer target used in messages: ``initial`` or 8 hex characters."""
    return "initial" if target == INITIAL else target[:8]


class RepoError(Exception):
    """Raised when the repository is missing a release or cannot be read."""


class ChainError(RepoError):
    """Raised when the pointer log's hash chain does not verify."""


class ReleaseRepo:
    """A directory of landed releases plus the production pointer log."""

    def __init__(self, root: Path) -> None:
        self.root = root

    @property
    def pointer_path(self) -> Path:
        """Path of the append-only pointer log."""
        return self.root / POINTER_FILE

    def release_dir(self, commit: str) -> Path:
        """Return the folder holding ``commit``'s manifest and files."""
        if not COMMIT_RE.fullmatch(commit):
            raise RepoError(f"not a commit id: {commit!r}")
        return self.root / "releases" / commit

    def files_dir(self, commit: str) -> Path:
        """Return the folder holding ``commit``'s file contents."""
        return self.release_dir(commit) / "files"

    def has_release(self, commit: str) -> bool:
        """Return True if ``commit`` was landed into this repository."""
        return (self.release_dir(commit) / "release.json").is_file()

    def put_release(self, release: Release, source: Path) -> None:
        """Copy ``source``'s files into the repository as ``release`` (idempotent).

        Every file is re-hashed while it is copied, so a file edited between hashing and landing
        is caught instead of being stored under the wrong commit. The release becomes visible
        only when complete: it is built in a temporary folder and renamed into place.

        Raises:
            ReleaseError: if a file no longer matches the hash the release recorded.
        """
        if self.has_release(release.commit):
            return
        incoming = self.root / "releases" / f".incoming-{release.commit}-{time.time_ns()}"
        files_root = incoming / "files"
        try:
            for name, expected in release.files.items():
                data = (source / name).read_bytes()
                if sha256_bytes(data) != expected:
                    raise ReleaseError(f"{name} changed while the release was being landed")
                target = files_root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            write_json_atomic(incoming / "release.json", release.manifest())
            final = self.release_dir(release.commit)
            try:
                rename_path(incoming, final)
            except OSError:
                # A concurrent land of the same content won the race; theirs is identical.
                if not self.has_release(release.commit):
                    raise
        finally:
            shutil.rmtree(incoming, ignore_errors=True)

    def load_release(self, commit: str) -> Release:
        """Load a landed release's manifest.

        Raises:
            RepoError: if the release was never landed here.
            ReleaseError: if the stored manifest is damaged.
        """
        manifest = read_json(self.release_dir(commit) / "release.json")
        if manifest is None:
            raise RepoError(f"release {commit[:8]} is not in the repository")
        release = Release.from_manifest(manifest)
        if release.commit != commit:
            raise ReleaseError("stored manifest belongs to a different commit")
        return release

    def pointer_entries(self) -> list[dict[str, Any]]:
        """Return every pointer entry, oldest first, after verifying the hash chain.

        Each returned entry carries an extra ``id`` (the hash of its own line) that is not stored.

        Raises:
            ChainError: if a line is unreadable or does not commit to the line before it.
        """
        if not self.pointer_path.is_file():
            return []
        entries: list[dict[str, Any]] = []
        previous = GENESIS
        lines = self.pointer_path.read_text(encoding="utf-8").splitlines()
        for number, line in enumerate(lines, start=1):
            entry = _parse_line(line)
            if entry is None or entry.get("prev") != previous or entry.get("seq") != number:
                raise ChainError(f"pointer log breaks at line {number}")
            previous = sha256_bytes(line.encode("utf-8"))
            entries.append({**entry, "id": previous})
        return entries

    def append_pointer(
        self,
        target: str,
        why: str,
        *,
        approval_id: str | None = None,
        approval_code: str | None = None,
    ) -> dict[str, Any]:
        """Append one pointer entry naming what production should serve, and return it.

        The approval code travels in the entry because the controller must see it to check it
        against its stored hashes. The entry is the audit record of the request; the controller
        burns the code on first use, so a code in an old entry is worthless.

        Args:
            target: a commit id, or ``INITIAL`` for the pre-controller site.
            why: free text for the audit trail (never put the approval code here).
            approval_id: id of the approval record that authorised this release.
            approval_code: the one-time code, if the release has never been live.

        Raises:
            RepoError: if ``target`` is neither a commit id nor ``INITIAL``.
        """
        if target != INITIAL and not COMMIT_RE.fullmatch(target):
            raise RepoError(f"not a valid pointer target: {target!r}")
        with FileLock(self.root / "pointer.lock", timeout=30):
            entries = self.pointer_entries()
            entry = {
                "seq": len(entries) + 1,
                "at": utc_now(),
                "target": target,
                "why": why,
                "approval_id": approval_id,
                "approval_code": approval_code,
                "prev": entries[-1]["id"] if entries else GENESIS,
            }
            line = canonical(entry)
            self.pointer_path.parent.mkdir(parents=True, exist_ok=True)
            with self.pointer_path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        return {**entry, "id": sha256_bytes(line.encode("utf-8"))}


def _parse_line(line: str) -> dict[str, Any] | None:
    """Parse one pointer-log line; return None if it is not a JSON object."""
    try:
        value = json.loads(line)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None
