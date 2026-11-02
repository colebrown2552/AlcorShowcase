"""Read-only macOS backend for the shared AlcorComputer runtime."""

from __future__ import annotations

import ctypes
import platform
import subprocess
from collections.abc import Mapping
from typing import Any

from .base import BackendError


class MacOSBackend:
    """Observation-only macOS backend: screen size and foreground window, no input.

    ``perform`` and ``screenshot`` always refuse. It exists so ``Computer`` can describe a
    Mac without being able to act on it; acting goes through ``MacOSAppBackend``.
    """

    name = "macos"

    def _require_host(self) -> None:
        if platform.system() != "Darwin":
            raise BackendError("platform_mismatch")

    def _cg(self) -> Any:
        self._require_host()
        try:
            cg = ctypes.CDLL(
                "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
            )
        except OSError as exc:
            raise BackendError("coregraphics_unavailable") from exc
        cg.CGMainDisplayID.restype = ctypes.c_uint32
        cg.CGDisplayPixelsWide.argtypes = [ctypes.c_uint32]
        cg.CGDisplayPixelsWide.restype = ctypes.c_size_t
        cg.CGDisplayPixelsHigh.argtypes = [ctypes.c_uint32]
        cg.CGDisplayPixelsHigh.restype = ctypes.c_size_t
        return cg

    def status(self) -> Mapping[str, Any]:
        """Report which capabilities exist (observation only)."""
        return {
            "ok": platform.system() == "Darwin",
            "backend": self.name,
            "capabilities": ["screen_size", "foreground_window"],
            "observation_backend_enabled": True,
            "screenshot_capture_enabled": False,
            "input_backend_enabled": False,
            "permissions": "managed_by_macos_privacy_controls",
        }

    def screen_size(self) -> tuple[int, int]:
        """Return the main display size in pixels via CoreGraphics.

        Raises:
            BackendError: ``platform_mismatch`` off macOS, ``coregraphics_unavailable``.
        """
        cg = self._cg()
        display = cg.CGMainDisplayID()
        return int(cg.CGDisplayPixelsWide(display)), int(cg.CGDisplayPixelsHigh(display))

    def foreground_window(self) -> Mapping[str, Any]:
        """Return the frontmost process name and its front window title via AppleScript.

        Raises:
            BackendError: ``foreground_query_unavailable`` or ``foreground_query_denied``.
        """
        self._require_host()
        script = (
            'tell application "System Events" to tell (first process whose frontmost is true) '
            "to return (name as text) & linefeed & "
            '(if (count of windows) > 0 then name of front window as text else "")'
        )
        try:
            proc = subprocess.run(
                ["/usr/bin/osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except OSError as exc:
            raise BackendError("foreground_query_unavailable") from exc
        if proc.returncode != 0:
            raise BackendError("foreground_query_denied")
        lines = (proc.stdout or "").splitlines()
        return {
            "process": lines[0] if lines else "",
            "title": lines[1] if len(lines) > 1 else "",
        }

    def screenshot(self, path: str) -> Mapping[str, Any]:
        """Always refuses: screenshot capture is not enabled here."""
        self._require_host()
        raise BackendError("screenshot_capture_not_enabled")

    def perform(self, action: Mapping[str, Any]) -> None:
        """Always refuses: this backend has no input path."""
        raise BackendError("input_backend_not_enabled")
