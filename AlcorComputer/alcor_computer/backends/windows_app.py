"""Explicit Firefox-window backend for Windows.

The generic Windows backend (``windows.py``) can neither observe nor act. This one is bound to a
single already-running Firefox window, identified by window handle, process id, process start
time and executable path, never by a process name that another program could reuse. It reuses the
macOS app backend's protocol: ``prepare_action`` verifies the target and binds exactly one
action, and ``perform`` verifies it again before the Win32 provider fires the event.

No service, browser-debugging port, browser profile, shell or model is involved. Semantic
element discovery (UI Automation) is not part of this package: pass an ``element_provider`` to
supply it.
"""

from __future__ import annotations

import platform
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .base import BackendError
from .macos_app import MacOSAppBackend

TARGET = "org.mozilla.firefox"
ELEMENTS_SCHEMA = "alcor.firefox.accessibility-elements.v1"
# Keys a browser action may press. Anything else is refused before it reaches the OS.
SAFE_KEYS = frozenset(
    {
        "tab",
        "escape",
        "enter",
        "space",
        "backspace",
        "delete",
        "left",
        "right",
        "up",
        "down",
        "home",
        "end",
        "pageup",
        "pagedown",
        "ctrl+tab",
        "ctrl+shift+tab",
        "ctrl+a",
        "ctrl+home",
        "ctrl+end",
        "shift+tab",
        *(f"ctrl+{digit}" for digit in range(1, 9)),
    }
)


class WindowsAppBackend(MacOSAppBackend):
    """One already-running Firefox window; never a process-name sender.

    Args:
        window_handle: The window to bind to. If omitted, exactly one Firefox window must exist.
        api: A ``Win32`` instance (or a stand-in); created on demand when no provider is injected.
        snapshot_provider: Test seam returning the target's state instead of querying Win32.
        effect_provider: Test seam receiving each action instead of sending real input.
        element_provider: Callable returning the semantic-element projection for ``elements()``.
        monotonic: Monotonic clock override.

    Raises:
        BackendError: ``firefox_window_missing_or_ambiguous`` if no single window matches.
    """

    name = "windows-firefox-app"

    def __init__(
        self,
        window_handle: int | None = None,
        *,
        api: Any = None,
        snapshot_provider: Callable[[], Mapping[str, Any]] | None = None,
        effect_provider: Callable[[Mapping[str, Any], Mapping[str, Any]], None] | None = None,
        element_provider: Callable[[], Mapping[str, Any]] | None = None,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        kwargs: dict[str, Any] = {
            "snapshot_provider": snapshot_provider,
            "effect_provider": effect_provider,
        }
        if monotonic is not None:
            kwargs["monotonic"] = monotonic
        super().__init__(TARGET, **kwargs)
        if api is None and snapshot_provider is None:
            from .windows_win32 import Win32

            api = Win32()
        self.api = api
        self.window_handle = window_handle
        self._element_provider = element_provider
        self._process_identity: tuple[Any, Any, Any] | None = None
        if snapshot_provider is None:
            windows = api.firefox_windows()
            matches = [w for w in windows if window_handle is None or w["hwnd"] == window_handle]
            if len(matches) != 1:
                raise BackendError("firefox_window_missing_or_ambiguous")
            self.window_handle = matches[0]["hwnd"]
            self._process_identity = (matches[0]["pid"], matches[0]["started"], matches[0]["exe"])

    def _require_host_unless_injected(self) -> None:
        if self._snapshot_provider is None and platform.system() != "Windows":
            raise BackendError("platform_mismatch")

    def _query_target(self) -> Mapping[str, Any]:
        value = self.api.window(self.window_handle)
        if (value["pid"], value["started"], value["exe"]) != self._process_identity:
            raise BackendError("firefox_process_binding_changed")
        return {
            "bundle_id": TARGET,
            "pid": value["pid"],
            "process": "firefox.exe",
            "window_title": value["title"],
            "window_bounds": value["bounds"],
            "frontmost": value["frontmost"],
        }

    def prepare_action(self, expected_target: Mapping[str, Any], action: Mapping[str, Any]) -> None:
        """Apply the browser's extra limits, then run the shared prepare protocol.

        Raises:
            BackendError: ``browser_key_not_allowed`` or ``typed_control_character_forbidden``,
                or any error from the shared protocol.
        """
        if action.get("kind") == "key" and action.get("key") not in SAFE_KEYS:
            raise BackendError("browser_key_not_allowed")
        if action.get("kind") == "type" and any(ord(c) < 32 for c in action.get("text", "")):
            raise BackendError("typed_control_character_forbidden")
        super().prepare_action(expected_target, action)

    def _dispatch(self, action: Mapping[str, Any], target: Mapping[str, Any]) -> None:
        self.api.perform(self.window_handle, action)

    def screen_size(self) -> tuple[int, int]:
        """Return the primary display size in physical pixels."""
        return self.api.screen_size()

    def screenshot(self, path: str) -> Mapping[str, Any]:
        """Capture the frontmost target window to ``path`` (a new file) and return its metadata.

        The target is read before and after the capture and must be unchanged.

        Raises:
            BackendError: ``screenshot_requires_frontmost_target`` or ``screenshot_target_changed``.
        """
        state = self.target_state()
        if not state["frontmost"]:
            raise BackendError("screenshot_requires_frontmost_target")
        result = self.api.screenshot(self.window_handle, Path(path))
        if state != self.target_state():
            raise BackendError("screenshot_target_changed")
        return result

    def status(self) -> Mapping[str, Any]:
        """Report the shared target status plus Windows-specific capabilities."""
        result = dict(super().status())
        result.update(
            screenshot_capture_enabled=True,
            permissions="Windows session and UIPI; no elevation",
            target_window_handle=self.window_handle,
            browser_profile_access=False,
        )
        return result

    def elements(self) -> Mapping[str, Any]:
        """Return the element provider's bounded projection for the reflex executor.

        The projection must carry the expected schema id and this window's handle, and the
        target must be unchanged while it was produced.

        Raises:
            BackendError: ``firefox_elements_provider_missing``, ``firefox_elements_invalid``,
                ``firefox_elements_window_mismatch`` or ``elements_target_changed``.
        """
        before = self.target_state()
        if self._element_provider is None:
            raise BackendError("firefox_elements_provider_missing")
        value = self._element_provider()
        if not isinstance(value, Mapping) or value.get("schema") != ELEMENTS_SCHEMA:
            raise BackendError("firefox_elements_invalid")
        if self.window_handle is not None and value.get("window_handle") != self.window_handle:
            raise BackendError("firefox_elements_window_mismatch")
        if before != self.target_state():
            raise BackendError("elements_target_changed")
        return value
