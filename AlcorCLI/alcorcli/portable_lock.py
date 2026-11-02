"""Advisory exclusive file locking on POSIX and Windows, so a lease that says busy means busy.

The gate only ever needs flock's two shapes: block until we hold the lock, or fail loudly if
someone else does. POSIX gets ``fcntl.flock`` unchanged. Windows has no flock, so it gets
``msvcrt.locking`` over a one-byte region at offset 0 of the same descriptor.

Two differences are deliberate and worth knowing before you rely on this:

* Windows byte-range locks are mandatory, not advisory: while held, an unlocked reader in the
  same region is refused rather than merely uncoordinated. Lock a sidecar ``.lock`` file, not a
  file other readers stream. ``sidecar_lock`` does exactly that.
* ``msvcrt.LK_LOCK`` retries for about ten seconds and then raises, so ``blocking_exclusive``
  loops on the non-blocking form instead of trusting it.
"""

from __future__ import annotations

import contextlib
import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

__all__ = ["LockBusy", "blocking_exclusive", "release", "sidecar_lock", "try_exclusive"]

# One byte at offset 0. The region only has to be agreed on, not cover the file.
_REGION = 1


class LockBusy(Exception):
    """Another holder has the lock and we asked not to wait."""


if os.name == "nt":  # pragma: no cover - the platform split is covered on each OS in turn
    import msvcrt

    def _at_origin(fd: int) -> None:
        # msvcrt locks relative to the file cursor; flock does not. Pin the cursor first.
        os.lseek(fd, 0, os.SEEK_SET)

    def try_exclusive(fd: int) -> None:
        """Take the lock now or raise ``LockBusy``."""
        _at_origin(fd)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, _REGION)
        except OSError:
            raise LockBusy("locked by another holder") from None

    def blocking_exclusive(fd: int, *, timeout: float = 120.0) -> None:
        """Wait up to ``timeout`` seconds for the lock, then raise ``LockBusy``."""
        deadline = time.monotonic() + timeout
        while True:
            try:
                return try_exclusive(fd)
            except LockBusy:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)

    def release(fd: int) -> None:
        """Drop the lock. A double unlock is not an error."""
        _at_origin(fd)
        # Closing the descriptor releases the lock anyway, so a failed unlock is not an error.
        with contextlib.suppress(OSError):
            msvcrt.locking(fd, msvcrt.LK_UNLCK, _REGION)

else:
    import fcntl

    def try_exclusive(fd: int) -> None:
        """Take the lock now or raise ``LockBusy``."""
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LockBusy("locked by another holder") from None

    def blocking_exclusive(fd: int, *, timeout: float = 120.0) -> None:
        """Block in the kernel until the lock is ours."""
        del timeout  # flock blocks in the kernel; the argument exists for the Windows spelling.
        fcntl.flock(fd, fcntl.LOCK_EX)

    def release(fd: int) -> None:
        """Drop the lock."""
        fcntl.flock(fd, fcntl.LOCK_UN)


_THREAD_LOCKS: dict[str, threading.RLock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()
_HELD = threading.local()


def _thread_lock(key: str) -> threading.RLock:
    with _THREAD_LOCKS_GUARD:
        return _THREAD_LOCKS.setdefault(key, threading.RLock())


@contextmanager
def sidecar_lock(path: Path, timeout: float = 30.0) -> Iterator[None]:
    """Serialise every thread and process that works on ``path``.

    The lock lives on ``<path>.lock`` so readers of ``path`` itself are never blocked by the
    Windows mandatory-lock rule. A thread that already holds the lock may take it again, which
    lets a method that holds the lock call another that also wants it.

    Args:
        path: The data file to protect. It need not exist yet.
        timeout: Seconds to wait before giving up.

    Raises:
        LockBusy: If the lock was not obtained within ``timeout`` seconds.
    """
    key = os.path.normcase(str(path.resolve()))
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with _thread_lock(key):
        held: set[str] = _HELD.__dict__.setdefault("keys", set())
        if key in held:
            yield
            return
        with lock_path.open("a+b") as handle:
            # The region must exist for the Windows mandatory lock to apply to it.
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            fd = handle.fileno()
            started = time.monotonic()
            while True:
                try:
                    try_exclusive(fd)
                    break
                except LockBusy:
                    if time.monotonic() - started >= timeout:
                        raise
                    time.sleep(0.01)
            held.add(key)
            try:
                yield
            finally:
                held.discard(key)
                release(fd)
