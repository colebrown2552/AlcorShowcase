"""Apply one verified release to a host directory, or put the previous one back.

Host layout, the contract between this module, the web server and the controller::

    <host>/public/       the web root: every file of a release lives here and is swapped as one
    <host>/data/         the application's own data; nothing here ever reads or writes it
    <host>/.releases/    bookkeeping: current.json (the identity the web server exposes as the
                         X-Sitekit-Commit header), status.json (the controller's state, served at
                         /sitekit-status.json), initial.txt, and one folder per attempt

Steps: verify every hash while copying -> check syntax -> swap -> read back -> smoke checks. Any
failure puts the previous web root and identity back, so a bad release leaves the site as it was.
Staging (via ``transport``) and production (via ``controller``) both go through here, so a release
is verified the same way in both places.

Known limit: the swap is two renames (live -> previous, prepared -> live), not one atomic step, so
a request that lands between them sees a missing site. Closing the gap needs a symlink flip, which
the extraction left out to keep the layout plain files.
"""

from __future__ import annotations

import json
import re
import shutil
import time
from collections.abc import Callable, Sequence
from contextlib import suppress
from pathlib import Path, PurePosixPath
from typing import Any

from .fsutil import (
    canonical,
    rename_path,
    replace_file,
    sha256_bytes,
    sha256_file,
    write_json_atomic,
)
from .net import fetch
from .release import MAX_FILE_BYTES, Release, check_file_name

IDENTITY_SCHEMA = "sitekit.host-release.v1"
_INITIAL_RE = re.compile(r"auto-[0-9a-f]{40}-[0-9]+")


class DeployError(Exception):
    """Raised when a release cannot be applied. The previous release has been put back."""


def _check_json(data: bytes) -> None:
    json.loads(data)


# Syntax checks run on the bytes before anything is swapped in. Add a suffix to cover more files.
CHECKERS: dict[str, Callable[[bytes], None]] = {".json": _check_json}


class HostPaths:
    """Where things live under a host root (see the module docstring)."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.public = root / "public"
        self.releases = root / ".releases"
        self.identity = self.releases / "current.json"
        self.status = self.releases / "status.json"
        self.initial = self.releases / "initial.txt"


def make_smoke(
    base_url: str,
    release: Release | None,
    pages: Sequence[str],
    unserved: Sequence[str] = (),
) -> Callable[[], None]:
    """Build the post-swap check for a host that is served at ``base_url``.

    The check asks the site over HTTP, not the disk, because a correct tree behind a broken web
    server is still a broken site. Key pages must answer 200, and every released file must be
    served byte for byte as released.

    Args:
        base_url: where the host is served.
        release: the release whose files must be served, or None to check only ``pages``.
        pages: paths that must answer 200 (a query string defeats caches).
        unserved: file-name suffixes the host refuses to serve by design, skipped in the byte check.
    """

    def smoke() -> None:
        stamp = time.time_ns()
        base = base_url.rstrip("/")
        for page in pages:
            status, body, _ = fetch(f"{base}{page}?sitekit_check={stamp}")
            if status != 200 or not body:
                raise DeployError(f"smoke {page}: HTTP {status}")
        for name, expected in (release.files if release else {}).items():
            if name.endswith(tuple(unserved)):
                continue
            status, body, _ = fetch(f"{base}/{name}?sitekit_check={stamp}")
            if status != 200 or sha256_bytes(body) != expected:
                raise DeployError(f"served file differs from the release: {name} (HTTP {status})")

    return smoke


def _prepare(release: Release, files_root: Path, stage: Path) -> Path:
    """Copy the release into ``stage``, verifying each file; return the prepared web root.

    The manifest was validated when it was loaded, but this is the last step before bytes go
    live, so every name and hash is checked again rather than trusted.
    """
    prepared = stage / "prepared" / "public"
    prepared.mkdir(parents=True)
    for name, expected in release.files.items():
        check_file_name(name)
        source = files_root / name
        if source.is_symlink() or not source.is_file():
            raise DeployError(f"missing or irregular file in the release: {name}")
        data = source.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            raise DeployError(f"file too large: {name}")
        if sha256_bytes(data) != expected:
            raise DeployError(f"hash mismatch: {name}")
        checker = CHECKERS.get(PurePosixPath(name).suffix.lower())
        if checker is not None:
            try:
                checker(data)
            except ValueError as error:
                raise DeployError(f"syntax check failed: {name}") from error
        target = prepared / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return prepared


def _contains_symlink(root: Path) -> bool:
    return root.is_symlink() or any(path.is_symlink() for path in root.rglob("*"))


def _swap_out(paths: HostPaths, stage: Path) -> bool:
    """Move the live web root into ``stage/previous``; return True if there was one."""
    if not paths.public.exists():
        return False
    previous = stage / "previous"
    previous.mkdir(exist_ok=True)
    rename_path(paths.public, previous / "public")
    return True


def _put_back(
    paths: HostPaths, stage: Path, *, swapped_out: bool, installed: bool, old_identity: bytes | None
) -> None:
    """Undo a half-finished swap using only what this attempt actually moved.

    Tracking ``installed`` and ``swapped_out`` matters: a failure before the swap must leave the
    live web root alone, and a failure after it must set the attempted tree aside rather than
    delete it, so the evidence survives.
    """
    if installed:
        rejected = stage / "rejected"
        rejected.mkdir(exist_ok=True)
        rename_path(paths.public, rejected / "public")
    if swapped_out:
        rename_path(stage / "previous" / "public", paths.public)
    if old_identity is not None:
        tmp = paths.identity.with_name("current.restore")
        tmp.write_bytes(old_identity)
        replace_file(tmp, paths.identity)
    elif paths.identity.exists():
        paths.identity.unlink()


def apply_release(
    host: Path,
    release: Release,
    files_root: Path,
    *,
    smoke: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Make ``release`` the live web root of ``host``, or leave the host as it was.

    Args:
        host: the host root (see the module docstring for its layout).
        release: what to deploy.
        files_root: folder holding the release's file contents.
        smoke: called once the new tree is live and the identity is written; it raises to reject.

    Returns:
        A result document with counts and hashes (no absolute paths).

    Raises:
        DeployError: if verification, the swap, the read-back or the smoke check fails. The
            previous web root and identity have been restored before this is raised.
    """
    paths = HostPaths(host)
    paths.releases.mkdir(parents=True, exist_ok=True)
    stage = paths.releases / f"auto-{release.commit}-{time.time_ns()}"
    stage.mkdir()
    with suppress(OSError):  # no-op where the filesystem has no permission bits
        stage.chmod(0o700)
    try:
        prepared = _prepare(release, files_root, stage)
        if _contains_symlink(paths.public):
            raise DeployError("the live web root contains a symlink; refusing to swap it")
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    old_identity = paths.identity.read_bytes() if paths.identity.exists() else None
    swapped_out = installed = False
    try:
        swapped_out = _swap_out(paths, stage)
        rename_path(prepared, paths.public)
        installed = True
        manifest_sha = sha256_bytes(canonical(release.manifest()).encode("utf-8"))
        identity = {
            "schema": IDENTITY_SCHEMA,
            "commit": release.commit,
            "manifest_sha256": manifest_sha,
            "files": len(release.files),
        }
        write_json_atomic(paths.identity, identity, indent=None)
        for name, expected in release.files.items():
            if sha256_file(paths.public / name) != expected:
                raise DeployError(f"read-back mismatch: {name}")
        if smoke is not None:
            smoke()
        result = {
            "ok": True,
            "commit": release.commit,
            "files": len(release.files),
            "manifest_sha256": manifest_sha,
            "backup": f"{stage.name}/previous",
            "finished_at": time.time(),
        }
        write_json_atomic(stage / "receipt.json", result)
    except BaseException:
        _put_back(
            paths, stage, swapped_out=swapped_out, installed=installed, old_identity=old_identity
        )
        raise
    # Remember the pre-controller site only now that this release is known good, and only if the
    # tree we moved aside was not itself a controller release. Recording it earlier would point
    # at an emptied folder whenever the first release failed and was rolled back.
    if swapped_out and old_identity is None and not paths.initial.exists():
        paths.initial.write_text(stage.name, encoding="utf-8")
    return result


def restore_initial(host: Path, *, smoke: Callable[[], None] | None = None) -> dict[str, Any]:
    """Put back the site as it was before the controller's first release.

    The recorded copy is duplicated, not moved, so it stays available for a later restore.

    Raises:
        DeployError: if no pre-controller site was recorded, it is empty, or the smoke check fails
            (the live site is then put back as it was before this call).
    """
    paths = HostPaths(host)
    marker = paths.initial.read_text(encoding="utf-8").strip() if paths.initial.is_file() else ""
    source = paths.releases / marker / "previous" / "public"
    if not _INITIAL_RE.fullmatch(marker) or not source.is_dir() or not any(source.iterdir()):
        raise DeployError("no pre-controller site was recorded, or its copy is empty")
    stage = paths.releases / f"restore-{time.time_ns()}"
    prepared = stage / "prepared" / "public"
    prepared.parent.mkdir(parents=True)
    try:
        shutil.copytree(source, prepared)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    old_identity = paths.identity.read_bytes() if paths.identity.exists() else None
    swapped_out = installed = False
    try:
        swapped_out = _swap_out(paths, stage)
        rename_path(prepared, paths.public)
        installed = True
        paths.identity.unlink(missing_ok=True)  # the pre-controller site has no identity
        if smoke is not None:
            smoke()
    except BaseException:
        _put_back(
            paths, stage, swapped_out=swapped_out, installed=installed, old_identity=old_identity
        )
        raise
    return {"ok": True, "commit": None, "restored": marker, "finished_at": time.time()}
