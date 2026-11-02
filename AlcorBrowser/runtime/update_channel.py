"""The update channel: how a build is described, published, fetched and checked.

A channel is a directory, or any static web location with the same layout::

    version.json          version, build id, notes and one {path, sha256, size} row per file
    extension/<file>      files copied into every installed extension folder
    runtime/<file>        files copied into the broker's own runtime folder

This module owns the format on both sides: ``publish`` writes it, ``parse_manifest`` validates it,
and the two ``ChannelSource`` classes read it. ``updater.py`` decides what to do with a valid build.

What the checks prove, and what they do not
-------------------------------------------
Every file is compared with the manifest's SHA-256 and size before anything is installed, so a
truncated, corrupted or swapped file is refused. That is integrity, not authenticity: whoever can
write the channel can also write a manifest that matches their files, so these checks are not
signatures. Sign ``version.json`` (for example with Ed25519 and a pinned public key) before
trusting a channel you do not control end to end.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from email.message import Message
from pathlib import Path
from typing import IO, Protocol
from urllib.parse import quote, urlparse

MANIFEST_NAME = "version.json"
#: The two folders a channel carries, in the order they are listed and installed.
KINDS = ("extension", "runtime")
#: Per-install files. The installer writes them; a channel must never carry them.
INSTALL_LOCAL = frozenset({"config.js", "build.json"})
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_FILES = 200
#: Everything a fetch can raise that means "try again later" rather than "this build is bad".
FETCH_ERRORS = (OSError, ValueError, http.client.HTTPException)

_BUILD = re.compile(r"[0-9a-f]{12,64}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
# Names come from a manifest that may not be trusted, and become paths: keep them boring.
_FILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")
_WINDOWS_DEVICES = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{n}" for n in range(1, 10)}
    | {f"lpt{n}" for n in range(1, 10)}
)
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
# Matches the build field of config.js however a formatter quoted it: build: '' or "build": "ab12".
_BUILD_FIELD = re.compile(r"""(["']?build["']?\s*:\s*["'])[0-9a-fA-F]*(["'])""")


class ChannelError(ValueError):
    """The channel, its manifest or one of its files is unusable; the message is a short code."""


@dataclass(frozen=True)
class FileEntry:
    """One file a build ships.

    Attributes:
        path: Channel-relative path, ``extension/<name>`` or ``runtime/<name>``.
        sha256: Lower-case hex digest of the exact bytes.
        size: Length in bytes.
    """

    path: str
    sha256: str
    size: int

    @property
    def kind(self) -> str:
        """The folder: ``extension`` or ``runtime``."""
        return self.path.split("/", 1)[0]

    @property
    def name(self) -> str:
        """The file name without its folder."""
        return self.path.split("/", 1)[1]


@dataclass(frozen=True)
class Manifest:
    """A parsed ``version.json``.

    Attributes:
        version: Human-readable version, copied from the extension's manifest.
        build: Content id of the extension build (see ``build_id``); lower-case hex.
        published: UTC publication time, ``YYYY-MM-DD HH:MM``.
        notes: Short release notes shown in the popup.
        files: Every file the build ships.
    """

    version: str
    build: str
    published: str
    notes: tuple[str, ...]
    files: tuple[FileEntry, ...]

    def to_json(self) -> dict:
        """Return the manifest as the JSON object written to ``version.json``."""
        return {
            **self.summary(),
            "files": [{"path": f.path, "sha256": f.sha256, "size": f.size} for f in self.files],
        }

    def summary(self) -> dict:
        """Return the fields the popup shows: version, build, publication time and notes."""
        return {
            "version": self.version,
            "build": self.build,
            "published": self.published,
            "notes": list(self.notes),
        }


class ChannelSource(Protocol):
    """Where a channel's bytes come from."""

    kind: str

    def fetch(self, rel: str, limit: int) -> bytes:
        """Return the file at channel-relative path ``rel``, at most ``limit`` bytes."""
        ...


def sha256_bytes(data: bytes) -> str:
    """Return the lower-case hex SHA-256 of ``data``."""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    """Return the SHA-256 of a file, or an empty string if it cannot be read."""
    try:
        return sha256_bytes(Path(path).read_bytes())
    except OSError:
        return ""


def safe_name(name: str) -> bool:
    """Say whether ``name`` is an acceptable file name inside a channel folder.

    Letters, digits, dots, dashes and underscores only; no leading dot, no trailing dot, and not a
    Windows device name such as ``con`` or ``nul`` (Windows opens those as devices whatever the
    extension).
    """
    return (
        bool(_FILE_NAME.fullmatch(name))
        and not name.endswith(".")
        and name.split(".", 1)[0].lower() not in _WINDOWS_DEVICES
    )


def build_id(files: Iterable[FileEntry]) -> str:
    """Name an extension build by its content.

    The id covers every ``extension/`` file, path and digest, so any change to the extension,
    including a rename, gives a new id. The running extension reports its id; the broker compares
    it with the id on disk to learn that a newer copy is waiting. Runtime files are not part of the
    id: they are compared by digest instead.

    Args:
        files: Entries for the whole build; only ``extension/`` ones are used.

    Returns:
        A 64-character lower-case hex string.
    """
    lines = sorted(f"{f.path}:{f.sha256}" for f in files if f.kind == "extension")
    return sha256_bytes("\n".join(lines).encode("utf-8"))


def set_build(config_text: str, build: str) -> tuple[str, int]:
    """Point an extension's ``config.js`` at a new build id.

    The pattern accepts quoted or bare keys and either quote style, so it survives reformatting by
    a tool such as Prettier. ``build`` is spliced into JavaScript source, so it must be hex.

    Args:
        config_text: The current contents of ``config.js``.
        build: The new build id, lower-case hex.

    Returns:
        The new text and the number of fields that were changed.

    Raises:
        ChannelError: If ``build`` is not hex.
    """
    if not _BUILD.fullmatch(build):
        raise ChannelError("channel-build-invalid")
    return _BUILD_FIELD.subn(lambda m: m.group(1) + build + m.group(2), config_text)


def write_atomic(path: Path, data: bytes) -> None:
    """Write a file so a reader sees the old bytes or the new bytes, never a mixture."""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(3)}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def collect(source: Path) -> list[tuple[FileEntry, bytes]]:
    """Read every shippable file of a build, hashing the same bytes that will be copied.

    Args:
        source: A folder holding ``extension/`` and ``runtime/``.

    Returns:
        ``(entry, bytes)`` pairs, extension files first, each folder sorted by name. Hidden files,
        sub-folders and the per-install files (``config.js``, ``build.json``) are left out.

    Raises:
        ChannelError: If a folder is missing or a file name is not acceptable in a channel.
    """
    out = []
    for kind in KINDS:
        folder = Path(source) / kind
        if not folder.is_dir():
            raise ChannelError(f"build-missing-{kind}-folder")
        for path in sorted(p for p in folder.iterdir() if p.is_file()):
            if path.name.startswith(".") or path.name in INSTALL_LOCAL:
                continue
            if not safe_name(path.name):
                raise ChannelError(f"build-file-name-invalid: {path.name}")
            data = path.read_bytes()
            out.append((FileEntry(f"{kind}/{path.name}", sha256_bytes(data), len(data)), data))
    return out


def publish(
    source: Path, out: Path, notes: Sequence[str] = (), published: str | None = None
) -> Manifest:
    """Write a channel for the build in ``source`` into ``out``.

    Files are read once, hashed, and copied from the same bytes, so the manifest always describes
    what was shipped. ``version.json`` is written last and atomically: a client that sees the new
    manifest finds every file it names already in place. Files left over from an earlier build are
    removed afterwards.

    Args:
        source: A folder holding ``extension/`` and ``runtime/`` (this repository's layout).
        out: The channel directory to create or refresh.
        notes: Short release notes for the popup.
        published: Publication time text; defaults to the current UTC minute.

    Returns:
        The manifest that was written.

    Raises:
        ChannelError: If the build is not publishable (see ``collect`` and ``parse_manifest``).
    """
    collected = collect(source)
    entries = tuple(entry for entry, _ in collected)
    by_path = {entry.path: data for entry, data in collected}
    try:
        version = str(json.loads(by_path["extension/manifest.json"])["version"])
    except (KeyError, ValueError, TypeError) as exc:
        raise ChannelError("build-extension-manifest-invalid") from exc
    manifest = Manifest(
        version=version,
        build=build_id(entries),
        published=published or time.strftime("%Y-%m-%d %H:%M", time.gmtime()),
        notes=tuple(str(n) for n in notes),
        files=entries,
    )
    document = (json.dumps(manifest.to_json(), indent=2) + "\n").encode("utf-8")
    parse_manifest(document)  # never publish a manifest that clients would refuse
    out = Path(out)
    for entry, data in collected:
        dest = out / entry.path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    write_atomic(out / MANIFEST_NAME, document)
    shipped = {entry.path for entry in entries}
    for kind in KINDS:
        for stale in (out / kind).iterdir():
            if stale.is_file() and f"{kind}/{stale.name}" not in shipped:
                stale.unlink()
    return manifest


def parse_manifest(raw: bytes) -> Manifest:
    """Validate the bytes of a ``version.json`` and return it as a ``Manifest``.

    Everything is checked before use, because the manifest may come from a web location: the build
    id must be hex (it becomes part of a folder name and is written into JavaScript), each path
    must be exactly ``extension/<name>`` or ``runtime/<name>`` with a boring name, and each digest
    must be 64 hex characters.

    Args:
        raw: The file contents.

    Returns:
        The parsed manifest.

    Raises:
        ChannelError: With a short code naming the first problem found.
    """
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ChannelError("manifest-not-json") from exc
    if not isinstance(data, dict):
        raise ChannelError("manifest-not-object")
    build = data.get("build")
    if not isinstance(build, str) or not _BUILD.fullmatch(build):
        raise ChannelError("channel-build-invalid")
    rows = data.get("files")
    if not isinstance(rows, list) or not 0 < len(rows) <= MAX_FILES:
        raise ChannelError("channel-has-no-files")
    entries = [_entry(row) for row in rows]
    paths = [e.path for e in entries]
    if len(set(paths)) != len(paths):
        raise ChannelError("channel-file-entry-duplicate")
    # Without it the update would delete the extension's manifest and leave an unloadable folder.
    if "extension/manifest.json" not in paths:
        raise ChannelError("channel-missing-extension-manifest")
    notes = data.get("notes")
    return Manifest(
        version=str(data.get("version") or "")[:32],
        build=build,
        published=str(data.get("published") or "")[:32],
        notes=tuple(str(n)[:200] for n in notes[:20]) if isinstance(notes, list) else (),
        files=tuple(entries),
    )


def _entry(row: object) -> FileEntry:
    bad = ChannelError("channel-file-entry-invalid")
    if not isinstance(row, dict):
        raise bad
    path, digest, size = row.get("path"), row.get("sha256"), row.get("size")
    if not isinstance(path, str) or not isinstance(digest, str) or type(size) is not int:
        raise bad
    parts = path.split("/")
    if len(parts) != 2 or parts[0] not in KINDS or not safe_name(parts[1]):
        raise bad
    if parts[1] in INSTALL_LOCAL or not _SHA256.fullmatch(digest):
        raise bad
    if not 0 <= size <= MAX_FILE_BYTES:
        raise bad
    return FileEntry(path, digest, size)


def _check_relative(rel: str) -> None:
    """Accept only ``version.json`` or ``<kind>/<safe name>``; refuse everything else."""
    if rel == MANIFEST_NAME:
        return
    parts = rel.split("/")
    if len(parts) != 2 or parts[0] not in KINDS or not safe_name(parts[1]):
        raise ChannelError("channel-path-invalid")


class DirectoryChannel:
    """A channel that is a folder on this machine (or a share mounted as one)."""

    kind = "directory"

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def fetch(self, rel: str, limit: int) -> bytes:
        """Read one channel file, refusing anything that resolves outside the folder.

        Raises:
            ChannelError: If the path is not a channel path, escapes the folder, or is too large.
            OSError: If the file cannot be read.
        """
        _check_relative(rel)
        root = self.root.resolve()
        path = (root / rel).resolve()
        # A symlink inside the channel must not lead the updater to a file outside it.
        if not path.is_relative_to(root):
            raise ChannelError("channel-path-escape")
        with path.open("rb") as handle:
            data = handle.read(limit + 1)
        if len(data) > limit:
            raise ChannelError("channel-file-too-large")
        return data


class _SameOriginRedirects(urllib.request.HTTPRedirectHandler):
    """Follow redirects only within the same scheme and host.

    A channel served over https must not be able to bounce the updater to plain http or to another
    host, where the bytes would travel unprotected.
    """

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: Message,
        newurl: str,
    ) -> urllib.request.Request | None:
        old, new = urlparse(req.full_url), urlparse(newurl)
        if (old.scheme, old.netloc) != (new.scheme, new.netloc):
            raise urllib.error.HTTPError(newurl, code, "cross-origin redirect refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class WebChannel:
    """A channel on a static web server, laid out like a channel directory under one base URL."""

    kind = "web"

    def __init__(self, base_url: str, timeout_s: float = 60.0) -> None:
        self.base = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self._opener = urllib.request.build_opener(_SameOriginRedirects)

    def fetch(self, rel: str, limit: int) -> bytes:
        """Download one channel file, reading at most ``limit`` bytes.

        Raises:
            ChannelError: If the path is not a channel path or the body is larger than ``limit``.
            OSError: On network or HTTP errors.
        """
        _check_relative(rel)
        # The scheme was restricted to https (or loopback http) by open_source.
        request = urllib.request.Request(
            f"{self.base}/{quote(rel, safe='/')}", headers={"User-Agent": "AlcorBrowser-updater"}
        )
        with self._opener.open(request, timeout=self.timeout_s) as response:
            data = response.read(limit + 1)
        if len(data) > limit:
            raise ChannelError("channel-file-too-large")
        return data


def open_source(spec: str) -> DirectoryChannel | WebChannel:
    """Turn the ``update_channel`` setting into a source.

    An absolute path is a directory. A URL must be https; plain http is accepted only for a
    loopback address, which exists so the update path can be tried against a local test server.

    Args:
        spec: The configured text.

    Returns:
        The source.

    Raises:
        ChannelError: For an empty value, a relative path, or a URL that is not https.
    """
    spec = spec.strip()
    if not spec:
        raise ChannelError("channel-not-set")
    if "://" in spec:
        parts = urlparse(spec)
        loopback_http = parts.scheme == "http" and parts.hostname in _LOOPBACK_HOSTS
        if not parts.hostname or not (parts.scheme == "https" or loopback_http):
            raise ChannelError("channel-url-must-be-https")
        return WebChannel(spec)
    path = Path(spec).expanduser()
    if not path.is_absolute():
        raise ChannelError("channel-dir-must-be-absolute")
    return DirectoryChannel(path)
