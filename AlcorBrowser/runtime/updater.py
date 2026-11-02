"""Verified, reversible self-update for the broker and the extension copies it manages.

One update is a transaction, and live files are touched only in the last of three phases:

1. Stage: fetch every file of the new build into a scratch folder and check each against the
   manifest's SHA-256 and size. One mismatch aborts with nothing installed.
2. Back up: copy aside every file that will be replaced, and every extension folder.
3. Replace: swap the files in one by one. On any error the backup is restored, so the install is
   exactly what it was.

After a successful replace the extension is told to reload and the broker exits, so the native host
relaunches it from the new files (``Updater.on_applied`` does that; the broker supplies it).

Integrity is checked, authenticity is not; see ``update_channel`` for what that means.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import threading
import time
from collections.abc import Callable
from pathlib import Path

from update_channel import (
    FETCH_ERRORS,
    INSTALL_LOCAL,
    MANIFEST_NAME,
    MAX_MANIFEST_BYTES,
    ChannelError,
    ChannelSource,
    DirectoryChannel,
    FileEntry,
    Manifest,
    parse_manifest,
    set_build,
    sha256_bytes,
    sha256_file,
    write_atomic,
)

FIRST_CHECK_S = 45.0
#: The timer retries a build that failed to install at most this often; a person can ask sooner.
RETRY_FAILED_S = 3600.0
KEEP_BACKUPS = 3
_EXTENSION_FOLDERS = "extension-agents-*"


class Updater:
    """Polls a channel, verifies a newer build and installs it.

    Args:
        home: Broker home. Managed extension copies are its ``extension-agents-*`` folders and the
            updater keeps its scratch, backups and cache in ``home/state``.
        runtime_dir: The folder holding the broker's own modules.
        source: Where the channel is read from.
        receipt: Appends a row to the receipt log; called with keyword fields.
        on_applied: Called on a background thread after a successful install.
        interval_s: Seconds between background checks.

    Attributes:
        info: Outcome of the latest check, shown by ``browser_status``.
    """

    def __init__(
        self,
        home: Path,
        runtime_dir: Path,
        source: ChannelSource,
        receipt: Callable[..., None],
        on_applied: Callable[[], None],
        interval_s: float = 600.0,
    ) -> None:
        self.home = Path(home)
        self.runtime_dir = Path(runtime_dir)
        self.source = source
        self.receipt = receipt
        self.on_applied = on_applied
        self.interval_s = interval_s
        self.state_dir = self.home / "state"
        self.info: dict = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._reason = "timer"
        self._looping = False

    # ---- scheduling ------------------------------------------------------------------------

    def start(self) -> None:
        """Start the background loop: a first check shortly after start, then every interval."""
        self._looping = True
        threading.Thread(target=self._loop, name="alcorbrowser-updates", daemon=True).start()

    def request(self, reason: str) -> None:
        """Check now (the popup and the restart tool do this), without blocking the caller.

        With the background loop running, this wakes it. Without it (background checks switched
        off), the check runs once on its own thread: switching the timer off must not make an
        explicit request do nothing.
        """
        if self._looping:
            self._reason = reason
            self._wake.set()
        else:
            threading.Thread(
                target=self._check_safely, args=(reason,), name="alcorbrowser-check", daemon=True
            ).start()

    def _check_safely(self, reason: str) -> None:
        try:
            self.check(reason)
        except Exception as exc:  # a background check must never die silently; the receipt says why
            self.info = {"checked": int(time.time()), "error": type(exc).__name__}
            self.receipt(event="update-check-failed", reason=reason, error=type(exc).__name__)

    def _loop(self) -> None:
        self._wake.wait(FIRST_CHECK_S)
        while True:
            reason, self._reason = self._reason, "timer"
            self._wake.clear()
            self._check_safely(reason)
            self._wake.wait(self.interval_s)

    # ---- what is published and what is installed -------------------------------------------

    def published(self) -> dict:
        """Return the latest known channel summary (version, build, time, notes), or ``{}``.

        The cache written by the last successful check wins; a directory channel is also read
        directly so the popup has something to show before the first check.
        """
        candidates = [self.state_dir / "channel-cache.json"]
        if isinstance(self.source, DirectoryChannel):
            candidates.append(self.source.root / MANIFEST_NAME)
        for path in candidates:
            try:
                return parse_manifest(path.read_bytes()).summary()
            except (OSError, ChannelError):
                continue
        return {}

    def installed_builds(self) -> list[str]:
        """Return the build id recorded in each managed extension folder ("" if unreadable)."""
        out = []
        for folder in self._extension_dirs():
            try:
                record = json.loads((folder / "build.json").read_text(encoding="utf-8"))
                out.append(str(record.get("build") or ""))
            except (OSError, ValueError, AttributeError):
                out.append("")
        return out

    def _extension_dirs(self) -> list[Path]:
        # ".bak" folders are manual backups an operator made; they are not live installs.
        return sorted(
            p for p in self.home.glob(_EXTENSION_FOLDERS) if p.is_dir() and ".bak" not in p.name
        )

    @staticmethod
    def _runtime_applies(name: str) -> bool:
        return name.endswith(".py") or (name.endswith(".ps1") and os.name == "nt")

    def _needed(self, manifest: Manifest) -> bool:
        if any(build != manifest.build for build in self.installed_builds()):
            return True
        return any(
            self._runtime_applies(f.name) and sha256_file(self.runtime_dir / f.name) != f.sha256
            for f in manifest.files
            if f.kind == "runtime"
        )

    # ---- one check ---------------------------------------------------------------------------

    def check(self, reason: str = "timer") -> dict:
        """Fetch the manifest and, if the channel differs from this install, apply it.

        Args:
            reason: Why this check runs (``timer``, ``hub``, ``tool``, ...). Only the timer
                honours the hourly back-off after a failed build.

        Returns:
            ``{"ok": True, "needed": False}`` when up to date; ``{"ok": True, "applied": True,
            "to": <build>}`` after an install; ``{"ok": False, "failed": <step>}`` when the manifest
            or a file was refused or the install was rolled back; ``{"ok": False, "skipped":
            "recent-failure"}`` during back-off.
        """
        with self._lock:
            try:
                raw = self.source.fetch(MANIFEST_NAME, MAX_MANIFEST_BYTES)
                manifest = parse_manifest(raw)
            except (ChannelError, *FETCH_ERRORS) as exc:
                self.receipt(event="update-check-failed", reason=reason, error=_why(exc))
                self.info = {"checked": int(time.time()), "error": _why(exc), "reason": reason}
                return {"ok": False, "failed": "manifest", "error": _why(exc)}
            self.state_dir.mkdir(parents=True, exist_ok=True)
            write_atomic(self.state_dir / "channel-cache.json", raw)
            needed = self._needed(manifest)
            kept = {
                k: v for k, v in self.info.items() if k in ("last_failed_build", "last_failed_at")
            }
            self.info = {
                "checked": int(time.time()),
                "channel_version": manifest.version,
                "channel_build": manifest.build[:12],
                "needed": needed,
                "reason": reason,
                **kept,
            }
            if not needed:
                return {"ok": True, "needed": False}
            recently_failed = (
                time.time() - float(self.info.get("last_failed_at") or 0) < RETRY_FAILED_S
            )
            if (
                reason == "timer"
                and self.info.get("last_failed_build") == manifest.build
                and recently_failed
            ):
                return {"ok": False, "needed": True, "skipped": "recent-failure"}
            return self._apply(manifest, reason)

    # ---- the transaction ---------------------------------------------------------------------

    def _apply(self, manifest: Manifest, reason: str) -> dict:
        build, files = manifest.build, manifest.files
        frm = (self.installed_builds() or [""])[0][:12]
        started = time.time()
        self.receipt(
            event="update-start",
            reason=reason,
            frm=frm,
            to=build[:12],
            version=manifest.version,
            files=len(files),
        )

        def fail(step: str, **extra: object) -> dict:
            self.info.update(last_failed_build=build, last_failed_at=int(time.time()), error=step)
            self.receipt(
                event="update-failed",
                step=step,
                frm=frm,
                to=build[:12],
                ok=False,
                files=len(files),
                **extra,
            )
            return {"ok": False, "failed": step}

        # Phase 1: stage and verify everything. Nothing live has been touched yet.
        stage_root = self.state_dir / "update-stage"
        shutil.rmtree(stage_root, ignore_errors=True)
        stage = stage_root / f"{build[:12]}-{secrets.token_hex(3)}"
        try:
            for entry in files:
                data = self.source.fetch(entry.path, entry.size)
                if len(data) != entry.size or sha256_bytes(data) != entry.sha256:
                    shutil.rmtree(stage_root, ignore_errors=True)
                    return fail("verify", path=entry.path)
                (stage / entry.path).parent.mkdir(parents=True, exist_ok=True)
                (stage / entry.path).write_bytes(data)
        except (ChannelError, *FETCH_ERRORS) as exc:
            shutil.rmtree(stage_root, ignore_errors=True)
            return fail("download", error=_why(exc))
        self.receipt(event="update-staged", to=build[:12], files=len(files), ok=True)

        # Phases 2 and 3: back up, then replace. Any error restores the backup.
        stamp = f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{secrets.token_hex(2)}"
        backup = self.state_dir / "update-backup" / stamp
        runtime_files = [f for f in files if f.kind == "runtime" and self._runtime_applies(f.name)]
        extension_files = [f for f in files if f.kind == "extension"]
        folders = self._extension_dirs()
        existed = {f.name for f in runtime_files if (self.runtime_dir / f.name).is_file()}
        applied = 0
        try:
            self._back_up(backup, runtime_files, existed, folders)
            for entry in runtime_files:
                self._replace(stage / entry.path, self.runtime_dir / entry.name)
                applied += 1
            keep = {f.name for f in extension_files} | INSTALL_LOCAL
            for folder in folders:
                for entry in extension_files:
                    self._replace(stage / entry.path, folder / entry.name)
                    applied += 1
                for old in folder.iterdir():  # files the new build no longer ships
                    if old.is_file() and old.name not in keep:
                        old.unlink()
                self._stamp_build(folder, build)
            record = {"version": manifest.version, "build": build, "applied": int(time.time())}
            write_atomic(self.state_dir / "installed-channel.json", json.dumps(record).encode())
        except Exception as exc:  # whatever went wrong, the install must go back to what it was
            restored = self._restore(backup, runtime_files, existed, folders)
            shutil.rmtree(stage_root, ignore_errors=True)
            self.receipt(event="update-restored", ok=restored, backup=stamp)
            return fail("apply", error=type(exc).__name__, errno=getattr(exc, "errno", None))

        shutil.rmtree(stage_root, ignore_errors=True)
        self._prune_backups()
        self.info.pop("last_failed_build", None)
        self.receipt(
            event="update-applied",
            frm=frm,
            to=build[:12],
            version=manifest.version,
            files=len(files),
            applied=applied,
            ok=True,
            seconds=round(time.time() - started, 2),
            backup=stamp,
        )
        threading.Thread(target=self.on_applied, name="alcorbrowser-reload", daemon=True).start()
        return {"ok": True, "applied": True, "to": build[:12]}

    def _back_up(
        self, backup: Path, runtime_files: list[FileEntry], existed: set[str], folders: list[Path]
    ) -> None:
        (backup / "runtime").mkdir(parents=True, exist_ok=True)
        for entry in runtime_files:
            if entry.name in existed:
                shutil.copy2(self.runtime_dir / entry.name, backup / "runtime" / entry.name)
        for folder in folders:
            shutil.copytree(folder, backup / f"ext-{folder.name}", dirs_exist_ok=True)

    def _restore(
        self, backup: Path, runtime_files: list[FileEntry], existed: set[str], folders: list[Path]
    ) -> bool:
        """Put every touched file back: restore what existed, delete what the update added."""
        try:
            for entry in runtime_files:
                target = self.runtime_dir / entry.name
                if entry.name in existed:
                    self._replace(backup / "runtime" / entry.name, target)
                else:
                    target.unlink(missing_ok=True)
            for folder in folders:
                saved = backup / f"ext-{folder.name}"
                if not saved.is_dir():
                    continue
                kept = set()
                for src in saved.iterdir():
                    if src.is_file():
                        self._replace(src, folder / src.name)
                        kept.add(src.name)
                for current in folder.iterdir():
                    if current.is_file() and current.name not in kept:
                        current.unlink()
        except OSError:
            return False
        return True

    @staticmethod
    def _replace(src: Path, dst: Path) -> None:
        """Copy beside the target, then rename over it: a crash leaves the old file or the new."""
        tmp = dst.with_name(f".{dst.name}.{secrets.token_hex(3)}.new")
        try:
            shutil.copyfile(src, tmp)
            os.replace(tmp, dst)
        finally:
            tmp.unlink(missing_ok=True)

    @staticmethod
    def _stamp_build(folder: Path, build: str) -> None:
        """Record the new build in ``config.js`` (the extension reports it) and ``build.json``."""
        config = folder / "config.js"
        text, changed = set_build(config.read_text(encoding="utf-8"), build)
        if changed:
            write_atomic(config, text.encode("utf-8"))
        write_atomic(folder / "build.json", (json.dumps({"build": build}) + "\n").encode("utf-8"))

    def _prune_backups(self) -> None:
        try:
            backups = sorted(p for p in (self.state_dir / "update-backup").iterdir() if p.is_dir())
        except OSError:
            return
        for old in backups[:-KEEP_BACKUPS]:
            shutil.rmtree(old, ignore_errors=True)


def _why(exc: BaseException) -> str:
    """A short, path-free reason for a receipt: ChannelError codes verbatim, else the class name."""
    return str(exc) if isinstance(exc, ChannelError) else type(exc).__name__
