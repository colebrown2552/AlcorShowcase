"""A release: an immutable set of files named by a commit id.

The commit id is the SHA-256 of the canonical manifest (file path -> file hash) cut to 40 hex
characters. With a git-backed setup the same slot holds a git commit; nothing downstream cares
which, only that one id names exactly one tree of content. Everything the pipeline checks, ships
and records is keyed by this id, so "the thing tested is the thing shipped" is checkable.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .fsutil import canonical, sha256_bytes, sha256_file

SCHEMA = "sitekit.release.v1"
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
HASH_RE = re.compile(r"[0-9a-f]{64}")
NAME_RE = re.compile(r"[A-Za-z0-9_./-]+")
# Folders that are tooling state, not site content.
IGNORED_DIRS = frozenset({".git", ".sitekit", "__pycache__", "node_modules"})
# Bounds keep a mistaken source folder (a whole home directory, say) from becoming a release.
MAX_FILES = 10_000
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_RELEASE_BYTES = 128 * 1024 * 1024


class ReleaseError(ValueError):
    """Raised when a folder or manifest cannot be a valid release."""


def check_file_name(name: str) -> None:
    """Reject names that could escape the web root or confuse a shell.

    Raises:
        ReleaseError: if ``name`` is not a plain relative path of safe characters.
    """
    parts = PurePosixPath(name).parts
    if (
        not NAME_RE.fullmatch(name)
        or name.startswith("/")
        or not parts
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise ReleaseError(f"unsafe file name in release: {name!r}")


def commit_for(files: Mapping[str, str]) -> str:
    """Return the commit id for a ``{path: sha256}`` mapping."""
    manifest = {"schema": SCHEMA, "files": dict(sorted(files.items()))}
    return sha256_bytes(canonical(manifest).encode("utf-8"))[:40]


@dataclass(frozen=True)
class Release:
    """A named set of files: ``commit`` is derived from ``files`` and never set by hand."""

    commit: str
    files: Mapping[str, str]

    @classmethod
    def from_files(cls, files: Mapping[str, str]) -> Release:
        """Build a release from ``{path: sha256}``, validating every name and hash."""
        if not files:
            raise ReleaseError("nothing to release: the file list is empty")
        if len(files) > MAX_FILES:
            raise ReleaseError(f"too many files: {len(files)} (limit {MAX_FILES})")
        for name, digest in files.items():
            check_file_name(name)
            if not HASH_RE.fullmatch(digest):
                raise ReleaseError(f"bad file hash for {name!r}")
        ordered = dict(sorted(files.items()))
        return cls(commit=commit_for(ordered), files=ordered)

    @classmethod
    def from_dir(cls, root: Path) -> Release:
        """Hash every file under ``root`` and return the release it forms.

        Symlinks are refused rather than followed: a link could point outside the folder, and
        the release must contain exactly the bytes that were hashed.

        Raises:
            ReleaseError: for an empty folder, a symlink, an unsafe name or an over-size file.
        """
        files: dict[str, str] = {}
        total = 0
        for current, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
            for directory in dirnames:
                if (Path(current) / directory).is_symlink():
                    raise ReleaseError(f"symlink not allowed in a release: {directory}")
            for filename in sorted(filenames):
                path = Path(current) / filename
                name = path.relative_to(root).as_posix()
                if path.is_symlink():
                    raise ReleaseError(f"symlink not allowed in a release: {name}")
                size = path.stat().st_size
                total += size
                if size > MAX_FILE_BYTES or total > MAX_RELEASE_BYTES:
                    raise ReleaseError(f"release too large at {name}")
                files[name] = sha256_file(path)
        return cls.from_files(files)

    def manifest(self) -> dict[str, Any]:
        """Return the manifest document stored next to the release's files."""
        return {"schema": SCHEMA, "commit": self.commit, "files": dict(self.files)}

    @classmethod
    def from_manifest(cls, manifest: object) -> Release:
        """Rebuild a release from a stored manifest, checking that its commit matches its files.

        Raises:
            ReleaseError: if the manifest is malformed or its commit does not match its files.
        """
        if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
            raise ReleaseError("not a sitekit release manifest")
        files = manifest.get("files")
        if not isinstance(files, dict):
            raise ReleaseError("manifest has no file list")
        release = cls.from_files(files)
        if manifest.get("commit") != release.commit:
            raise ReleaseError("manifest commit does not match its files")
        return release
