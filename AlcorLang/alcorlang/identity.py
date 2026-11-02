"""A digest of the files that make up this implementation.

Two places need to name "the exact build that is running": the hosted authority challenge
(so a verifier can refuse a runtime it has not approved) and the native compile cache (so a
cached binary is never reused after the compiler or runtime changed).  Both use this one digest.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

_PACKAGE_DIR = Path(__file__).resolve().parent
# The file kinds that define behaviour: code, the vocabulary table and the lowering runtimes
# (the C runtime and its header, and the Python runtime text).
_SUFFIXES = frozenset({".py", ".json", ".c", ".h", ".txt"})


def implementation_sha256() -> str:
    """Hash every behaviour-defining file in the package.

    Files are visited in sorted order of their package-relative POSIX path, and each
    contributes its path, its length and its bytes, so renaming a file or moving bytes between
    two files changes the digest.

    Returns:
        The lowercase hex SHA-256.

    Raises:
        OSError: If a file cannot be read.  Callers treat that as "identity unavailable" and
            fail closed rather than substituting a made-up digest.
    """
    digest = hashlib.sha256()
    files = sorted(
        (path for path in _PACKAGE_DIR.rglob("*") if path.is_file() and path.suffix in _SUFFIXES),
        key=lambda path: path.relative_to(_PACKAGE_DIR).as_posix(),
    )
    for path in files:
        relative = path.relative_to(_PACKAGE_DIR).as_posix()
        raw = path.read_bytes()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()
