"""Backend protocol and error type shared by every backend of the shared runtime."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol


class BackendError(RuntimeError):
    """A backend refusal or failure with a bounded reason code and no payload.

    Attributes:
        reason_code: Short snake_case code such as ``target_not_frontmost``.
    """

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


class Backend(Protocol):
    """What ``Computer`` needs from a machine: observe it and, if armed, perform one action.

    Implementations raise ``BackendError`` for anything they will not or cannot do, and must not
    perform any action outside ``perform``.

    Attributes:
        name: Short platform label used in receipts.
    """

    name: str

    def status(self) -> Mapping[str, Any]:
        """Report capabilities and whether the backend is usable on this host."""
        ...

    def screen_size(self) -> tuple[int, int]:
        """Return the primary display size in pixels as ``(width, height)``."""
        ...

    def foreground_window(self) -> Mapping[str, Any]:
        """Describe the foreground window (at least a title and a process label)."""
        ...

    def screenshot(self, path: str) -> Mapping[str, Any]:
        """Capture the screen to a new file at ``path`` and return its metadata."""
        ...

    def perform(self, action: Mapping[str, Any]) -> None:
        """Perform one normalised action (``focus``, ``move``, ``click``, ``type`` or ``key``)."""
        ...
