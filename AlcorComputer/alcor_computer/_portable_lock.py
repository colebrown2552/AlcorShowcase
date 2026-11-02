"""Advisory exclusive file locking for POSIX and Windows.

The app controller needs exactly two things from a lock: fail at once if another holder has it
("busy means busy"), and let go when asked. POSIX gets ``fcntl.flock``. Windows has no ``flock``,
so it locks one byte at offset 0 of the same descriptor with ``msvcrt.locking``.

Two differences are deliberate and worth knowing before relying on this:

* A Windows byte-range lock is mandatory, not advisory. While it is held, another handle cannot
  read that byte. Anything that wants to read a locked file must release (close) it first.
* Closing the descriptor releases either kind of lock, so ``release`` is a courtesy that keeps
  the lock window explicit rather than a requirement.
"""

from __future__ import annotations

import contextlib
import os

# One byte at offset 0. The region only has to be agreed on, not to cover the file.
_REGION = 1


class LockBusy(Exception):
    """Another holder has the lock and the caller asked not to wait."""


def try_exclusive(fd: int) -> None:
    """Take an exclusive lock on ``fd`` without waiting.

    Args:
        fd: An open, writable file descriptor.

    Raises:
        LockBusy: If another descriptor, in this or another process, holds the lock.
    """
    if os.name == "nt":
        import msvcrt

        # msvcrt locks relative to the cursor, flock does not: always lock from the origin.
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, _REGION)
        except OSError:
            raise LockBusy("locked by another holder") from None
    else:
        import fcntl

        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LockBusy("locked by another holder") from None


def release(fd: int) -> None:
    """Release the lock taken by ``try_exclusive``. Releasing a lock that is not held is a no-op."""
    if os.name == "nt":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        # Closing the descriptor releases the lock anyway; a double unlock is not an error we own.
        with contextlib.suppress(OSError):
            msvcrt.locking(fd, msvcrt.LK_UNLCK, _REGION)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)
