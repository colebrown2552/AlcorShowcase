"""File helpers shared by the tools that write: an atomic replace and a byte-exact codec."""

from __future__ import annotations

import contextlib
import os
import stat
import tempfile
import time
from pathlib import Path


def decode_bytes(raw: bytes) -> str:
    """Bytes to text without loss.

    A byte that is not UTF-8 becomes a lone surrogate that ``encode_text`` turns straight back
    into the same byte, so a Latin-1 name or a CRLF file survives an edit that never mentioned it.
    Nothing here goes through text mode, so no newline is translated.
    """
    return raw.decode("utf-8", "surrogateescape")


def encode_text(text: str) -> bytes:
    """The inverse of ``decode_bytes``.

    Raises:
        UnicodeEncodeError: On a lone surrogate that did not come from a byte, such as a mangled
            emoji in a model-emitted call. Callers turn that into a refusal.
    """
    return text.encode("utf-8", "surrogateescape")


def atomic_replace(target: Path, data: bytes) -> None:
    """Replace ``target`` so a reader sees the old file or the new one, never an empty one.

    The target is never opened for truncation. The bytes go to a temporary file in the same
    directory, are fsynced, and then ``os.replace`` swaps the name. A write that fails leaves the
    old file exactly as it was, and the file's permission bits are kept.

    On Windows ``os.replace`` fails while another process has the target open without delete
    sharing, so the swap is retried briefly.
    """
    mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else None
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".alcor-write-", suffix=".tmp", dir=target.parent, delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        for attempt in range(100):
            try:
                os.replace(temporary, target)
                break
            except PermissionError:
                if os.name != "nt" or attempt == 99:
                    raise
                time.sleep(0.01)
        temporary = None
    finally:
        if temporary is not None:
            with contextlib.suppress(OSError):
                temporary.unlink(missing_ok=True)
