"""Windows backend seam for the shared AlcorComputer runtime."""

from __future__ import annotations

import platform
from collections.abc import Mapping
from typing import Any

from .base import BackendError


class WindowsBackend:
    """Placeholder Windows backend for ``Computer``: it can neither observe nor act.

    Real Windows work goes through ``WindowsAppBackend`` and ``Win32``, which are injected
    explicitly and are bound to one window.
    """

    name = "windows"

    def status(self) -> Mapping[str, Any]:
        """Report that no capability is enabled."""
        return {
            "ok": platform.system() == "Windows",
            "backend": self.name,
            "capabilities": [],
            "observation_backend_enabled": False,
            "input_backend_enabled": False,
        }

    def screen_size(self) -> tuple[int, int]:
        """Always refuses: observation is not enabled."""
        raise BackendError("observation_backend_not_enabled")

    def foreground_window(self) -> Mapping[str, Any]:
        """Always refuses: observation is not enabled."""
        raise BackendError("observation_backend_not_enabled")

    def screenshot(self, path: str) -> Mapping[str, Any]:
        """Always refuses: screenshots are not enabled."""
        raise BackendError("screenshot_backend_not_enabled")

    def perform(self, action: Mapping[str, Any]) -> None:
        """Always refuses: this backend has no input path."""
        raise BackendError("input_backend_not_enabled")
