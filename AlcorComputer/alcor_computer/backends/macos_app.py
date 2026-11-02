"""Explicit-target macOS backend for ``AppController``.

It is deliberately not chosen by ``Computer``; the embedding program constructs it after
naming one bundle identifier. It never launches an application and cannot switch targets.
Every input is preceded by two exact identity checks, ``prepare_action`` and ``perform``,
so a window that changed in between is caught.

``snapshot_provider`` and ``effect_provider`` replace the AppleScript and CoreGraphics
calls with caller-supplied functions. Tests and the demo use them to run the full
protocol against an in-memory window.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import math
import platform
import re
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from typing import Any

from .base import BackendError

_BUNDLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$")
_PREPARED_MAX_AGE_SECONDS = 0.5
_KEY_CODES = {
    "a": 0,
    "s": 1,
    "d": 2,
    "f": 3,
    "h": 4,
    "g": 5,
    "z": 6,
    "x": 7,
    "c": 8,
    "v": 9,
    "b": 11,
    "q": 12,
    "w": 13,
    "e": 14,
    "r": 15,
    "y": 16,
    "t": 17,
    "1": 18,
    "2": 19,
    "3": 20,
    "4": 21,
    "6": 22,
    "5": 23,
    "=": 24,
    "9": 25,
    "7": 26,
    "-": 27,
    "8": 28,
    "0": 29,
    "]": 30,
    "o": 31,
    "u": 32,
    "[": 33,
    "i": 34,
    "p": 35,
    "enter": 36,
    "l": 37,
    "j": 38,
    "'": 39,
    "k": 40,
    ";": 41,
    "\\": 42,
    ",": 43,
    "/": 44,
    "n": 45,
    "m": 46,
    ".": 47,
    "tab": 48,
    "space": 49,
    "backspace": 51,
    "escape": 53,
    "left": 123,
    "right": 124,
    "down": 125,
    "up": 126,
}


# JXA program that re-checks the target and then sends one key code or keystroke. The four
# placeholders are the JSON-encoded bundle id, the pid, the operation and the value, so model
# text is data inside this fixed program, never source.
_KEYBOARD_SCRIPT = """
function run() {
  const wanted = %s;
  const pid = %d;
  const operation = %s;
  const value = %s;
  const se = Application("System Events");
  const matches = se.applicationProcesses.whose({bundleIdentifier: wanted})();
  if (matches.length !== 1 || Number(matches[0].unixId()) !== pid ||
      !Boolean(matches[0].frontmost())) {
    return "REFUSED";
  }
  if (operation === "key") se.keyCode(Number(value));
  else se.keystroke(String(value));
  return "OK";
}
"""


class _CGPoint(ctypes.Structure):
    _fields_ = (("x", ctypes.c_double), ("y", ctypes.c_double))


def _action_digest(action: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        dict(action), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _same_identity(first: Mapping[str, Any], second: Mapping[str, Any]) -> bool:
    return all(
        first.get(field) == second.get(field)
        for field in ("bundle_id", "pid", "window_title", "window_bounds")
    )


def _point_inside(x: int, y: int, bounds: Mapping[str, Any]) -> bool:
    return (
        bounds["x"] <= x < bounds["x"] + bounds["width"]
        and bounds["y"] <= y < bounds["y"] + bounds["height"]
    )


class MacOSAppBackend:
    """A one-target backend which can never switch bundle identifiers."""

    name = "macos-app"

    def __init__(
        self,
        target_bundle_id: str,
        *,
        snapshot_provider: Callable[[], Mapping[str, Any]] | None = None,
        effect_provider: Callable[[Mapping[str, Any], Mapping[str, Any]], None] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        bundle_id = str(target_bundle_id or "").strip()
        if _BUNDLE_ID.fullmatch(bundle_id) is None or "." not in bundle_id:
            raise BackendError("invalid_target_bundle_id")
        self.target_bundle_id = bundle_id
        self._snapshot_provider = snapshot_provider
        self._effect_provider = effect_provider
        self._monotonic = monotonic
        self._prepared: dict[str, Any] | None = None
        self._lock = threading.RLock()

    def status(self) -> Mapping[str, Any]:
        """Report the target's running state and the capabilities of this backend."""
        try:
            target = self.target_state()
        except BackendError as exc:
            return {
                "ok": False,
                "backend": self.name,
                "target_bundle_id": self.target_bundle_id,
                "reason_code": exc.reason_code,
                "input_backend_enabled": True,
                "screenshot_capture_enabled": False,
            }
        return {
            "ok": True,
            "backend": self.name,
            "target_bundle_id": self.target_bundle_id,
            "target_running": True,
            "target_frontmost": target["frontmost"],
            "capabilities": ["target_state", "focus", "move", "click", "key", "type"],
            "input_backend_enabled": True,
            "screenshot_capture_enabled": False,
            "permissions": "managed_by_macos_privacy_controls",
        }

    def target_state(self) -> dict[str, Any]:
        """Return a validated snapshot of the target app: pid, title, bounds, focus.

        Raises:
            BackendError: If the target is missing, ambiguous, has another bundle id
                or reports malformed fields.
        """
        self._require_host_unless_injected()
        raw = (
            self._snapshot_provider()
            if self._snapshot_provider is not None
            else self._query_target()
        )
        if not isinstance(raw, Mapping):
            raise BackendError("target_observation_invalid")
        if raw.get("ok") is False:
            raise BackendError(str(raw.get("reason_code") or "target_unavailable"))
        if raw.get("bundle_id") != self.target_bundle_id:
            raise BackendError("target_identity_mismatch")
        pid = raw.get("pid")
        if type(pid) is not int or pid < 1:
            raise BackendError("target_pid_invalid")
        title = raw.get("window_title")
        if not isinstance(title, str) or "\x00" in title or len(title) > 512:
            raise BackendError("target_window_title_invalid")
        bounds = self._normalize_bounds(raw.get("window_bounds"))
        process = raw.get("process")
        if not isinstance(process, str) or "\x00" in process or len(process) > 256:
            raise BackendError("target_process_invalid")
        return {
            "bundle_id": self.target_bundle_id,
            "pid": pid,
            "process": process,
            "window_title": title,
            "window_bounds": bounds,
            "frontmost": raw.get("frontmost") is True,
        }

    def prepare_action(self, expected_target: Mapping[str, Any], action: Mapping[str, Any]) -> None:
        """Reverify a recent target and bind exactly one immediate action."""
        with self._lock:
            self._prepared = None
            current = self.target_state()
            if not _same_identity(expected_target, current):
                raise BackendError("target_changed_since_observation")
            kind = action.get("kind")
            if kind != "focus" and current.get("frontmost") is not True:
                raise BackendError("target_not_frontmost")
            if kind in {"move", "click"} and not _point_inside(
                action["x"], action["y"], current["window_bounds"]
            ):
                raise BackendError("pointer_outside_target_window")
            self._prepared = {
                "action_sha256": _action_digest(action),
                "target": current,
                "prepared_monotonic": self._monotonic(),
            }

    def screen_size(self) -> tuple[int, int]:
        """Return the display size (or, with a snapshot provider, the window's extent)."""
        self._require_host_unless_injected()
        if self._snapshot_provider is not None:
            state = self.target_state()
            bounds = state["window_bounds"]
            return (
                max(1, bounds["x"] + bounds["width"]),
                max(1, bounds["y"] + bounds["height"]),
            )
        cg = self._application_services()
        cg.CGMainDisplayID.restype = ctypes.c_uint32
        cg.CGDisplayPixelsWide.argtypes = [ctypes.c_uint32]
        cg.CGDisplayPixelsWide.restype = ctypes.c_size_t
        cg.CGDisplayPixelsHigh.argtypes = [ctypes.c_uint32]
        cg.CGDisplayPixelsHigh.restype = ctypes.c_size_t
        display = cg.CGMainDisplayID()
        return int(cg.CGDisplayPixelsWide(display)), int(cg.CGDisplayPixelsHigh(display))

    def foreground_window(self) -> Mapping[str, Any]:
        """Describe the target app's window."""
        state = self.target_state()
        return {
            "process": state["process"],
            "title": state["window_title"],
            "bundle_id": state["bundle_id"],
            "pid": state["pid"],
            "frontmost": state["frontmost"],
        }

    def screenshot(self, path: str) -> Mapping[str, Any]:
        """Always refuses: screenshot capture is not enabled for app control."""
        del path
        raise BackendError("screenshot_capture_not_enabled")

    def perform(self, action: Mapping[str, Any]) -> None:
        """Consume one prepared action after a second target verification."""
        with self._lock:
            prepared = self._prepared
            self._prepared = None
            if prepared is None or prepared.get("action_sha256") != _action_digest(action):
                raise BackendError("action_not_prepared")
            age = self._monotonic() - float(prepared["prepared_monotonic"])
            if age < 0 or age > _PREPARED_MAX_AGE_SECONDS:
                raise BackendError("prepared_action_expired")
            current = self.target_state()
            if not _same_identity(prepared["target"], current):
                raise BackendError("target_changed_before_effect")
            kind = action.get("kind")
            if kind != "focus" and current.get("frontmost") is not True:
                raise BackendError("target_not_frontmost")
            if kind in {"move", "click"} and not _point_inside(
                action["x"], action["y"], current["window_bounds"]
            ):
                raise BackendError("pointer_outside_target_window")
            if self._effect_provider is not None:
                self._effect_provider(dict(action), current)
            else:
                self._dispatch(action, current)
            if kind == "focus":
                after = self.target_state()
                if not _same_identity(current, after) or after.get("frontmost") is not True:
                    raise BackendError("focus_not_acquired")

    @staticmethod
    def _normalize_bounds(value: Any) -> dict[str, int]:
        if not isinstance(value, Mapping):
            raise BackendError("target_window_bounds_invalid")
        out: dict[str, int] = {}
        for field in ("x", "y", "width", "height"):
            item = value.get(field)
            if type(item) not in (int, float) or not math.isfinite(float(item)):
                raise BackendError("target_window_bounds_invalid")
            integer = int(item)
            if float(item) != float(integer):
                raise BackendError("target_window_bounds_invalid")
            out[field] = integer
        if out["width"] < 1 or out["height"] < 1:
            raise BackendError("target_window_bounds_invalid")
        return out

    def _require_host_unless_injected(self) -> None:
        if self._snapshot_provider is None and platform.system() != "Darwin":
            raise BackendError("platform_mismatch")

    def _query_target(self) -> Mapping[str, Any]:
        script = r"""
function run(argv) {
  const wanted = argv[0];
  const se = Application("System Events");
  const matches = se.applicationProcesses.whose({bundleIdentifier: wanted})();
  if (matches.length === 0) return JSON.stringify({ok:false, reason_code:"target_not_running"});
  if (matches.length !== 1) return JSON.stringify({ok:false, reason_code:"target_ambiguous"});
  const p = matches[0];
  const windows = p.windows();
  if (windows.length === 0) return JSON.stringify({ok:false, reason_code:"target_has_no_window"});
  const w = windows[0];
  const position = w.position();
  const size = w.size();
  return JSON.stringify({
    ok:true,
    bundle_id:String(p.bundleIdentifier()),
    pid:Number(p.unixId()),
    process:String(p.name()),
    window_title:String(w.name()),
    window_bounds:{
      x:Number(position[0]), y:Number(position[1]),
      width:Number(size[0]), height:Number(size[1])
    },
    frontmost:Boolean(p.frontmost())
  });
}
"""
        try:
            done = subprocess.run(
                [
                    "/usr/bin/osascript",
                    "-l",
                    "JavaScript",
                    "-e",
                    script,
                    "--",
                    self.target_bundle_id,
                ],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BackendError("target_query_unavailable") from exc
        if done.returncode != 0:
            raise BackendError("target_query_denied")
        try:
            value = json.loads(done.stdout or "{}")
        except (TypeError, ValueError) as exc:
            raise BackendError("target_query_invalid") from exc
        return value

    def _dispatch(self, action: Mapping[str, Any], target: Mapping[str, Any]) -> None:
        kind = action["kind"]
        if kind == "focus":
            self._focus(int(target["pid"]))
        elif kind in {"move", "click"}:
            self._pointer(kind, int(action["x"]), int(action["y"]), target)
        elif kind in {"key", "type"}:
            self._keyboard(action, target)
        else:  # Computer normalizes before this boundary.
            raise BackendError("unsupported_action")

    def _focus(self, pid: int) -> None:
        script = r"""
function run(argv) {
  const wanted = argv[0];
  const pid = Number(argv[1]);
  const se = Application("System Events");
  const matches = se.applicationProcesses.whose({bundleIdentifier: wanted})();
  if (matches.length !== 1 || Number(matches[0].unixId()) !== pid) return "REFUSED";
  matches[0].frontmost = true;
  return "OK";
}
"""
        try:
            done = subprocess.run(
                [
                    "/usr/bin/osascript",
                    "-l",
                    "JavaScript",
                    "-e",
                    script,
                    "--",
                    self.target_bundle_id,
                    str(pid),
                ],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BackendError("focus_unavailable") from exc
        if done.returncode != 0 or (done.stdout or "").strip() != "OK":
            raise BackendError("focus_refused")

    def _keyboard(self, action: Mapping[str, Any], target: Mapping[str, Any]) -> None:
        if action["kind"] == "key":
            key = str(action["key"]).lower()
            if key not in _KEY_CODES:
                raise BackendError("unsupported_key")
            operation, value = "key", _KEY_CODES[key]
        else:
            operation, value = "type", str(action["text"])
        # The payload travels over stdin, never argv or the environment.
        script = _KEYBOARD_SCRIPT % (  # noqa: UP031 - printf style: the JavaScript has braces
            json.dumps(self.target_bundle_id, ensure_ascii=True),
            int(target["pid"]),
            json.dumps(operation),
            json.dumps(value, ensure_ascii=True),
        )
        try:
            done = subprocess.run(
                ["/usr/bin/osascript", "-l", "JavaScript", "-"],
                input=script,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BackendError("keyboard_unavailable") from exc
        if done.returncode != 0 or (done.stdout or "").strip() != "OK":
            raise BackendError("keyboard_refused")

    def _pointer(self, kind: str, x: int, y: int, target: Mapping[str, Any]) -> None:
        # Recheck after all preparation and immediately before constructing the
        # global event. CoreGraphics has no atomic target-addressed pointer API.
        latest = self.target_state()
        if not _same_identity(target, latest) or latest.get("frontmost") is not True:
            raise BackendError("target_changed_before_pointer_effect")
        if not _point_inside(x, y, latest["window_bounds"]):
            raise BackendError("pointer_outside_target_window")
        cg = self._application_services()
        cg.CGEventCreateMouseEvent.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            _CGPoint,
            ctypes.c_uint32,
        ]
        cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
        cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        cg.CGEventPost.restype = None
        core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        core.CFRelease.argtypes = [ctypes.c_void_p]
        point = _CGPoint(float(x), float(y))
        event_types = (5,) if kind == "move" else (1, 2)
        for event_type in event_types:
            event = cg.CGEventCreateMouseEvent(None, event_type, point, 0)
            if not event:
                raise BackendError("pointer_event_unavailable")
            try:
                cg.CGEventPost(0, event)
            finally:
                core.CFRelease(event)
            if kind == "click":
                time.sleep(0.02)

    @staticmethod
    def _application_services() -> Any:
        try:
            return ctypes.CDLL(
                "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
            )
        except OSError as exc:
            raise BackendError("coregraphics_unavailable") from exc


__all__ = ["MacOSAppBackend"]
