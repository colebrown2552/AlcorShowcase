"""Filesystem helpers shared by every module: hashing, atomic JSON writes, file locks, digests.

Anything that must survive a crash (receipts, the controller's status, approval hashes) is written
through ``write_json_atomic`` or ``replace_file`` so a reader never sees a half-written file.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

if os.name == "nt":
    import msvcrt
else:
    import fcntl

_CHUNK = 1024 * 1024
_RETRIES = 40
_RETRY_DELAY = 0.05


def utc_now() -> str:
    """Return the current UTC time as ``YYYY-MM-DDTHH:MM:SSZ``."""
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    """Return the SHA-256 of ``data`` as lowercase hex."""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    """Return the SHA-256 of a file, read in chunks so a large file does not fill memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical(obj: Any) -> str:
    """Serialize ``obj`` as compact, key-sorted JSON so equal data always hashes equally."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_json(path: Path, default: Any = None) -> Any:
    """Read a JSON file, returning ``default`` when it is missing or not valid JSON."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _retry(operation: Callable[[], None]) -> None:
    """Run ``operation``, retrying briefly on Windows where a reader can pin a file open.

    On Windows a rename or replace fails with PermissionError while another process holds the
    file open. The holder is almost always a request that finishes in milliseconds, so waiting a
    moment is correct; elsewhere the error is real and is raised at once.
    """
    for attempt in range(_RETRIES):
        try:
            operation()
            return
        except PermissionError:
            if os.name != "nt" or attempt == _RETRIES - 1:
                raise
            time.sleep(_RETRY_DELAY)


def replace_file(src: Path, dst: Path) -> None:
    """Atomically replace ``dst`` with ``src`` (same filesystem), retrying on Windows."""
    _retry(lambda: os.replace(src, dst))


def rename_path(src: Path, dst: Path) -> None:
    """Rename a file or directory; fails if ``dst`` exists, so a swap never merges two trees."""
    _retry(lambda: os.rename(src, dst))


def write_json_atomic(path: Path, obj: Any, *, indent: int | None = 2) -> None:
    """Write ``obj`` as JSON through a temporary file, so readers see the old or the new file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=indent) + "\n", encoding="utf-8", newline="\n")
    replace_file(tmp, path)


def tree_digest(root: Path) -> str:
    """Return an order-independent digest of every file under ``root``.

    Used as an "untouched" proof: equal digests before and after an operation mean no file
    under the tree was added, removed or changed. A missing tree digests like an empty one.
    """
    digest = hashlib.sha256()
    if root.is_dir():
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            digest.update(path.relative_to(root).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


class LockTimeout(Exception):
    """Raised when a ``FileLock`` could not be taken within its timeout."""


class FileLock:
    """An exclusive lock on a file, released by the operating system if the holder dies.

    The private deployment used ``flock``; this wraps ``flock`` on POSIX and ``msvcrt.locking``
    on Windows. Because the OS drops the lock with the process, there are no stale lock files to
    detect or clean up.
    """

    def __init__(self, path: Path, timeout: float = 0.0) -> None:
        self.path = path
        self.timeout = timeout
        self._fd: int | None = None

    def acquire(self) -> None:
        """Take the lock, polling until ``timeout`` seconds have passed.

        Raises:
            LockTimeout: if another holder keeps the lock for the whole timeout.
        """
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                _lock_fd(fd)
            except OSError:
                if time.monotonic() >= deadline:
                    os.close(fd)
                    raise LockTimeout(f"{self.path.name} is held by another process") from None
                time.sleep(0.1)
            else:
                self._fd = fd
                return

    def release(self) -> None:
        """Release the lock if it is held."""
        if self._fd is not None:
            _unlock_fd(self._fd)
            os.close(self._fd)
            self._fd = None

    def __enter__(self) -> FileLock:
        self.acquire()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.release()


def _lock_fd(fd: int) -> None:
    """Try to take an exclusive lock on ``fd`` without blocking; raises OSError if held."""
    if os.name == "nt":
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_fd(fd: int) -> None:
    """Release the lock taken by ``_lock_fd``."""
    if os.name == "nt":
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
