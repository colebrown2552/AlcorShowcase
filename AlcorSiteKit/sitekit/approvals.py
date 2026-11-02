"""One-time approval codes, stored only as SHA-256 hashes.

The person with approval authority runs ``sitekit approve`` and sees the codes once; the store
keeps hashes only, so reading the file reveals nothing that can be presented. A code is burned the
first time the controller accepts it, even if the deploy that follows fails: a failed release
needs a fresh approval, which keeps "one code, one release" simple to audit.

The operator driving a release can present a code but cannot mint one. In the private deployment
that separation is enforced with file permissions on the host; the offline demo runs everything as
one user, so there it is a convention, not a barrier.
"""

from __future__ import annotations

import hmac
import re
import secrets
import string
from contextlib import suppress
from pathlib import Path

from .fsutil import FileLock, replace_file, sha256_bytes

# Digits plus the letters Crockford base32 keeps (no I, L, O, U): 32 symbols, 5 bits each, so a
# 16-symbol code carries 80 bits and survives being read aloud or retyped.
_ALPHABET = string.digits + "ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 16
GROUP_SIZE = 4


def normalize_code(code: str) -> str:
    """Return ``code`` upper-cased with spaces and dashes removed, so grouping does not matter."""
    return re.sub(r"[\s-]", "", code).upper()


def code_digest(code: str) -> str:
    """Return the SHA-256 hex digest that identifies ``code`` in the store."""
    return sha256_bytes(normalize_code(code).encode("utf-8"))


class ApprovalStore:
    """A file with one code hash per line."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def _read(self) -> list[str]:
        if not self.path.is_file():
            return []
        return self.path.read_text(encoding="utf-8").split()

    def _write(self, hashes: list[str]) -> None:
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text("".join(h + "\n" for h in hashes), encoding="utf-8", newline="\n")
        with suppress(OSError):  # no-op where the filesystem has no permission bits
            tmp.chmod(0o600)
        replace_file(tmp, self.path)

    def mint(self, count: int) -> list[str]:
        """Create ``count`` codes, store their hashes and return the codes.

        The returned codes exist only in this return value; nothing on disk can recover them.
        """
        codes = []
        for _ in range(count):
            raw = "".join(secrets.choice(_ALPHABET) for _ in range(CODE_LENGTH))
            codes.append(
                "-".join(raw[i : i + GROUP_SIZE] for i in range(0, CODE_LENGTH, GROUP_SIZE))
            )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(self.path.with_name(self.path.name + ".lock"), timeout=10):
            self._write(self._read() + [code_digest(code) for code in codes])
        return codes

    def redeem(self, code: str | None) -> bool:
        """Accept ``code`` once: return True and burn it, or return False if unknown or used."""
        if not code:
            return False
        wanted = code_digest(code)
        with FileLock(self.path.with_name(self.path.name + ".lock"), timeout=10):
            hashes = self._read()
            # Constant-time comparison: the store is the secret, so do not leak by timing.
            match = next((h for h in hashes if hmac.compare_digest(h, wanted)), None)
            if match is None:
                return False
            hashes.remove(match)
            self._write(hashes)
        return True

    def remaining(self) -> int:
        """Return how many unused codes are left."""
        return len(self._read())
