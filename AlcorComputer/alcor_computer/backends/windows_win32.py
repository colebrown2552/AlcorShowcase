"""Typed Win32 adapter: the one place that touches window handles, SendInput and GDI.

``Win32`` is a thin, defensive wrapper over ``user32``, ``kernel32`` and ``gdi32`` via ``ctypes``.
It holds no authority of its own: callers (``WindowsAppBackend``, ``alcor_click``) decide what is
allowed, and every method here re-verifies the window it is about to act on, then refuses rather
than guesses.

The input structures are fixed-width so this module can be imported, and its pure helpers tested,
on any platform. Constructing ``Win32`` on a non-Windows host raises ``platform_mismatch``.
"""

from __future__ import annotations

import contextlib
import ctypes as C
import hashlib
import os
import struct
import time
import zlib
from collections.abc import Iterator, Mapping
from ctypes import wintypes as W
from pathlib import Path
from typing import Any

from .base import BackendError

U32 = C.c_uint32
U16 = C.c_uint16
I32 = C.c_int32
UP = C.c_size_t

# GetAsyncKeyState virtual keys: shift, ctrl, alt, left win, right win, left and right button.
# If any is down the user is mid-gesture, and injecting input would corrupt it.
_USER_INPUT_KEYS = (16, 17, 18, 91, 92, 1, 2)
_IDENTITY_FIELDS = ("hwnd", "pid", "started", "exe", "title", "bounds")
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_MAX_TYPED_CHARS = 1024


class MOUSE(C.Structure):
    """Win32 ``MOUSEINPUT``."""

    _fields_ = (
        ("dx", I32),
        ("dy", I32),
        ("mouseData", U32),
        ("dwFlags", U32),
        ("time", U32),
        ("dwExtraInfo", UP),
    )


class KEY(C.Structure):
    """Win32 ``KEYBDINPUT``."""

    _fields_ = (
        ("wVk", U16),
        ("wScan", U16),
        ("dwFlags", U32),
        ("time", U32),
        ("dwExtraInfo", UP),
    )


class HARDWARE(C.Structure):
    """Win32 ``HARDWAREINPUT`` (present only so the union has its real size)."""

    _fields_ = (("uMsg", U32), ("wParamL", U16), ("wParamH", U16))


class UNION(C.Union):
    """The anonymous union inside Win32 ``INPUT``."""

    _fields_ = (("mi", MOUSE), ("ki", KEY), ("hi", HARDWARE))


class INPUT(C.Structure):
    """Win32 ``INPUT``: ``type`` 0 is mouse, 1 is keyboard."""

    _anonymous_ = ("u",)
    _fields_ = (("type", U32), ("u", UNION))


class BITMAPINFOHEADER(C.Structure):
    """Win32 ``BITMAPINFOHEADER`` for ``GetDIBits``."""

    _fields_ = (
        ("size", U32),
        ("width", I32),
        ("height", I32),
        ("planes", U16),
        ("bits", U16),
        ("compression", U32),
        ("imagesize", U32),
        ("xppm", I32),
        ("yppm", I32),
        ("used", U32),
        ("important", U32),
    )


KEYS = {
    "ctrl": 0x11,
    "shift": 0x10,
    "tab": 9,
    "escape": 27,
    "enter": 13,
    "space": 32,
    "backspace": 8,
    "delete": 46,
    "left": 37,
    "up": 38,
    "right": 39,
    "down": 40,
    "home": 36,
    "end": 35,
    "pageup": 33,
    "pagedown": 34,
    "a": 65,
    **{str(n): 48 + n for n in range(1, 9)},
}


def key_events(key: str) -> list[INPUT]:
    """Build the key-down then key-up events for a chord such as ``ctrl+shift+tab``.

    Modifiers go down in the order written and up in reverse. Navigation keys (page up through
    delete) carry the extended-key flag.

    Raises:
        BackendError: ``browser_key_not_allowed`` if the chord is not in ``SAFE_KEYS``.
    """
    from .windows_app import SAFE_KEYS

    if key not in SAFE_KEYS:
        raise BackendError("browser_key_not_allowed")
    codes = [KEYS[part] for part in key.split("+")]
    events = []
    for code in codes:
        events.append(INPUT(type=1, ki=KEY(wVk=code, dwFlags=1 if code in range(33, 47) else 0)))
    for code in reversed(codes):
        events.append(
            INPUT(type=1, ki=KEY(wVk=code, dwFlags=2 | (1 if code in range(33, 47) else 0)))
        )
    return events


def text_events(text: str) -> list[INPUT]:
    """Build Unicode key-down and key-up events that type ``text`` without keyboard layouts.

    Raises:
        BackendError: ``typed_text_invalid`` for empty, over-long or control-character text.
    """
    if not isinstance(text, str) or not 1 <= len(text) <= _MAX_TYPED_CHARS:
        raise BackendError("typed_text_invalid")
    if any(ord(c) < 32 for c in text):
        raise BackendError("typed_text_invalid")
    encoded = text.encode("utf-16-le")
    codes = struct.unpack("<" + "H" * (len(encoded) // 2), encoded)
    events: list[INPUT] = []
    for code in codes:
        # KEYEVENTF_UNICODE, then the same with KEYEVENTF_KEYUP.
        events.append(INPUT(type=1, ki=KEY(wScan=code, dwFlags=4)))
        events.append(INPUT(type=1, ki=KEY(wScan=code, dwFlags=6)))
    return events


def png_bytes(width: int, height: int, bgra: bytes) -> bytes:
    """Encode a top-down BGRA pixel buffer as an RGB PNG using only ``zlib`` and ``struct``.

    Raises:
        BackendError: ``screenshot_buffer_mismatch`` if the buffer is not ``width*height*4``.
    """
    if len(bgra) != width * height * 4:
        raise BackendError("screenshot_buffer_mismatch")
    # Keep RGB only; the alpha byte of a screen capture carries no meaning.
    rgb = bytearray(width * height * 3)
    rgb[0::3] = bgra[2::4]
    rgb[1::3] = bgra[1::4]
    rgb[2::3] = bgra[0::4]
    raw = b"".join(b"\0" + rgb[y * width * 3 : (y + 1) * width * 3] for y in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 3))
        + chunk(b"IEND", b"")
    )


def _same_window(expected: Mapping[str, Any], current: Mapping[str, Any]) -> bool:
    """Compare the identity fields of two window descriptions."""
    return all(expected.get(field) == current.get(field) for field in _IDENTITY_FIELDS)


class Win32:
    """Defensive Win32 wrapper. Every action re-checks the window it targets.

    Raises:
        BackendError: ``platform_mismatch`` when constructed anywhere but Windows.
    """

    def __init__(self) -> None:
        if os.name != "nt":
            raise BackendError("platform_mismatch")
        self.u = C.WinDLL("user32", use_last_error=True)
        self.k = C.WinDLL("kernel32", use_last_error=True)
        self.g = C.WinDLL("gdi32", use_last_error=True)
        u, k, g = self.u, self.k, self.g
        self._bind(u, "GetForegroundWindow", [], W.HWND)
        self._bind(u, "GetWindowThreadProcessId", [W.HWND, C.POINTER(W.DWORD)], W.DWORD)
        self._bind(u, "GetWindowRect", [W.HWND, C.POINTER(W.RECT)], W.BOOL)
        self._bind(u, "GetWindowTextW", [W.HWND, W.LPWSTR, C.c_int], C.c_int)
        self._bind(u, "GetClassNameW", [W.HWND, W.LPWSTR, C.c_int], C.c_int)
        for name in ("IsWindow", "IsWindowVisible", "IsIconic", "SetForegroundWindow"):
            self._bind(u, name, [W.HWND], W.BOOL)
        self._bind(u, "GetAncestor", [W.HWND, W.UINT], W.HWND)
        self._bind(u, "WindowFromPoint", [W.POINT], W.HWND)
        self._bind(u, "SetCursorPos", [C.c_int, C.c_int], W.BOOL)
        self._bind(u, "GetCursorPos", [C.POINTER(W.POINT)], W.BOOL)
        self._bind(u, "GetSystemMetrics", [C.c_int], C.c_int)
        self._bind(u, "GetAsyncKeyState", [C.c_int], C.c_short)
        self._bind(u, "SendInput", [W.UINT, C.POINTER(INPUT), C.c_int], W.UINT)
        self._bind(u, "SetThreadDpiAwarenessContext", [C.c_void_p], C.c_void_p)
        self._bind(k, "OpenProcess", [W.DWORD, W.BOOL, W.DWORD], W.HANDLE)
        self._bind(k, "CloseHandle", [W.HANDLE], W.BOOL)
        self._bind(
            k,
            "QueryFullProcessImageNameW",
            [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)],
            W.BOOL,
        )
        self._bind(k, "GetProcessTimes", [W.HANDLE, *([C.POINTER(W.FILETIME)] * 4)], W.BOOL)
        self._bind(k, "GetCurrentProcessId", [], W.DWORD)
        self._bind(k, "ProcessIdToSessionId", [W.DWORD, C.POINTER(W.DWORD)], W.BOOL)
        self._bind(k, "WTSGetActiveConsoleSessionId", [], W.DWORD)
        self._bind(u, "GetDC", [W.HWND], W.HDC)
        self._bind(u, "ReleaseDC", [W.HWND, W.HDC], C.c_int)
        self._bind(g, "CreateCompatibleDC", [W.HDC], W.HDC)
        self._bind(g, "CreateCompatibleBitmap", [W.HDC, C.c_int, C.c_int], W.HBITMAP)
        self._bind(g, "SelectObject", [W.HDC, W.HANDLE], W.HANDLE)
        self._bind(
            g,
            "BitBlt",
            [W.HDC, C.c_int, C.c_int, C.c_int, C.c_int, W.HDC, C.c_int, C.c_int, W.DWORD],
            W.BOOL,
        )
        self._bind(
            g,
            "GetDIBits",
            [W.HDC, W.HBITMAP, W.UINT, W.UINT, C.c_void_p, C.c_void_p, W.UINT],
            C.c_int,
        )
        self._bind(g, "DeleteObject", [W.HANDLE], W.BOOL)
        self._bind(g, "DeleteDC", [W.HDC], W.BOOL)

    @staticmethod
    def _bind(library: Any, name: str, argtypes: list[Any], restype: Any) -> None:
        function = getattr(library, name)
        function.argtypes = argtypes
        function.restype = restype

    @contextlib.contextmanager
    def pixels(self) -> Iterator[None]:
        """Run the body in a per-monitor-aware DPI context so coordinates are physical pixels.

        Raises:
            BackendError: ``physical_pixel_context_unavailable`` if Windows refuses the context.
        """
        old = self.u.SetThreadDpiAwarenessContext(C.c_void_p(-4))
        if not old:
            raise BackendError("physical_pixel_context_unavailable")
        try:
            yield
        finally:
            self.u.SetThreadDpiAwarenessContext(old)

    def desktop(self, pid: int | None = None) -> None:
        """Require that this process (and optionally ``pid``) is in the active console session.

        Raises:
            BackendError: ``active_desktop_session_mismatch`` or
                ``target_desktop_session_mismatch``.
        """
        active = self.k.WTSGetActiveConsoleSessionId()
        session = W.DWORD()
        if (
            active == 0xFFFFFFFF
            or not self.k.ProcessIdToSessionId(self.k.GetCurrentProcessId(), C.byref(session))
            or session.value != active
        ):
            raise BackendError("active_desktop_session_mismatch")
        if pid is not None and (
            not self.k.ProcessIdToSessionId(pid, C.byref(session)) or session.value != active
        ):
            raise BackendError("target_desktop_session_mismatch")

    def _window_facts(self, hwnd: int, *, not_queryable: str) -> dict[str, Any]:
        """Collect pid, start time, executable path, title, focus and bounds for one window.

        ``not_queryable`` is the reason code to raise if the process cannot be opened.
        """
        pid = W.DWORD()
        self.u.GetWindowThreadProcessId(hwnd, C.byref(pid))
        self.desktop(pid.value)
        handle = self.k.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not handle:
            raise BackendError(not_queryable)
        try:
            buffer = C.create_unicode_buffer(32768)
            size = W.DWORD(len(buffer))
            if not self.k.QueryFullProcessImageNameW(handle, 0, buffer, C.byref(size)):
                raise BackendError("process_path_unavailable")
            path = Path(buffer.value)
            times = [W.FILETIME() for _ in range(4)]
            if not self.k.GetProcessTimes(handle, *(C.byref(x) for x in times)):
                raise BackendError("process_start_unavailable")
            started = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        finally:
            self.k.CloseHandle(handle)
        text = C.create_unicode_buffer(513)
        self.u.GetWindowTextW(hwnd, text, 513)
        with self.pixels():
            rect = W.RECT()
            if not self.u.GetWindowRect(hwnd, C.byref(rect)):
                raise BackendError("window_bounds_unavailable")
        return {
            "hwnd": int(hwnd),
            "pid": pid.value,
            "started": started,
            "exe": str(path),
            "title": text.value,
            "frontmost": self.u.GetForegroundWindow() == hwnd,
            "bounds": {
                "x": rect.left,
                "y": rect.top,
                "width": rect.right - rect.left,
                "height": rect.bottom - rect.top,
            },
        }

    def window(self, hwnd: int) -> dict[str, Any]:
        """Describe one visible Firefox window, binding it to the installed executable.

        The process image must be the installed Firefox executable under Program Files,
        so a renamed binary or a shell cannot pass as the browser.

        Raises:
            BackendError: Whenever the window is missing, minimised, not Firefox, or not queryable.
        """
        self.desktop()
        if not self.u.IsWindow(hwnd) or not self.u.IsWindowVisible(hwnd):
            raise BackendError("firefox_window_unavailable")
        window_class = C.create_unicode_buffer(128)
        self.u.GetClassNameW(hwnd, window_class, 128)
        if window_class.value != "MozillaWindowClass":
            raise BackendError("firefox_window_class_mismatch")
        facts = self._window_facts(hwnd, not_queryable="firefox_process_not_queryable")
        allowed = [
            Path(os.environ.get(variable, "")) / "Mozilla Firefox/firefox.exe"
            for variable in ("ProgramFiles", "ProgramFiles(x86)")
            if os.environ.get(variable)
        ]
        if not any(os.path.normcase(facts["exe"]) == os.path.normcase(str(p)) for p in allowed):
            raise BackendError("firefox_executable_not_allowlisted")
        if self.u.IsIconic(hwnd):
            raise BackendError("firefox_window_minimized")
        return facts

    def window_any(self, hwnd: int) -> dict[str, Any]:
        """Describe one visible top-level window without choosing a target.

        Raises:
            BackendError: ``window_unavailable`` or ``window_minimized`` and the session errors.
        """
        self.desktop()
        if not hwnd or not self.u.IsWindow(hwnd) or not self.u.IsWindowVisible(hwnd):
            raise BackendError("window_unavailable")
        if self.u.IsIconic(hwnd):
            raise BackendError("window_minimized")
        return self._window_facts(hwnd, not_queryable="process_not_queryable")

    def foreground_window(self) -> dict[str, Any]:
        """Describe the current foreground window, which must still be foreground when read."""
        hwnd = self.u.GetForegroundWindow()
        if not hwnd:
            raise BackendError("foreground_window_unavailable")
        value = self.window_any(hwnd)
        if not value["frontmost"]:
            raise BackendError("foreground_window_changed")
        return value

    def cursor_position(self) -> dict[str, int]:
        """Return the cursor position in physical screen pixels."""
        point = W.POINT()
        with self.pixels():
            if not self.u.GetCursorPos(C.byref(point)):
                raise BackendError("cursor_position_unavailable")
        return {"x": int(point.x), "y": int(point.y)}

    def firefox_windows(self) -> list[dict[str, Any]]:
        """Enumerate every top-level window that passes the Firefox checks in ``window``."""
        self.desktop()
        found: list[dict[str, Any]] = []
        callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)

        def collect(hwnd: int, _: int) -> bool:
            with contextlib.suppress(BackendError):
                found.append(self.window(hwnd))
            return True

        callback = callback_type(collect)
        self._bind(self.u, "EnumWindows", [callback_type, W.LPARAM], W.BOOL)
        if not self.u.EnumWindows(callback, 0):
            raise BackendError("window_enumeration_failed")
        return found

    def perform_foreground_click(
        self, expected: Mapping[str, Any], x: int, y: int
    ) -> dict[str, Any]:
        """Left-click at ``(x, y)`` if the foreground window is still exactly ``expected``.

        The point must lie inside the window and must not be covered by another window.

        Raises:
            BackendError: ``target_changed_since_observation``, ``pointer_outside_target_window``,
                ``target_point_occluded``, ``pointer_move_failed``, ``target_not_frontmost`` or
                ``user_input_in_progress``.
        """
        current = self.foreground_window()
        if not _same_window(expected, current):
            raise BackendError("target_changed_since_observation")
        b = current["bounds"]
        if not b["x"] <= x < b["x"] + b["width"] or not b["y"] <= y < b["y"] + b["height"]:
            raise BackendError("pointer_outside_target_window")
        with self.pixels():
            at = self.u.WindowFromPoint(W.POINT(x, y))
            root = self.u.GetAncestor(at, 2)
            if root != current["hwnd"]:
                raise BackendError("target_point_occluded")
            if not self.u.SetCursorPos(x, y):
                raise BackendError("pointer_move_failed")
            if self.u.GetForegroundWindow() != current["hwnd"]:
                raise BackendError("target_not_frontmost")
            self._send([INPUT(type=0, mi=MOUSE(dwFlags=2)), INPUT(type=0, mi=MOUSE(dwFlags=4))])
        return self.foreground_window()

    def _focus_exact(self, expected: Mapping[str, Any]) -> dict[str, Any]:
        """Ask Windows once to foreground ``expected`` and confirm it did.

        One normal OS request, no fallback escalation: a denied foreground request stays denied.
        Attaching to another thread's input queue could reset key state and is not a substitute
        for the user choosing the intended window.
        """
        hwnd = expected["hwnd"]
        if any(self.u.GetAsyncKeyState(v) & 0x8000 for v in _USER_INPUT_KEYS):
            raise BackendError("user_input_in_progress")
        if self.u.GetForegroundWindow() != hwnd and not self.u.SetForegroundWindow(hwnd):
            raise BackendError("focus_denied_by_windows")
        time.sleep(0.05)
        current = self.window_any(hwnd)
        same = all(current.get(k) == expected.get(k) for k in ("hwnd", "pid", "started", "exe"))
        if self.u.GetForegroundWindow() != hwnd or not same:
            raise BackendError("focus_not_acquired")
        return current

    def focus_window(self, hwnd: int) -> dict[str, Any]:
        """Foreground one visible window by handle and return its description."""
        return self._focus_exact(self.window_any(hwnd))

    def perform_foreground_key(self, expected: Mapping[str, Any], key: str) -> dict[str, Any]:
        """Press an allowlisted key chord if the foreground window is still ``expected``."""
        current = self.foreground_window()
        if not _same_window(expected, current):
            raise BackendError("target_changed_since_observation")
        self._send(key_events(key))
        return self.foreground_window()

    def perform_foreground_type(self, expected: Mapping[str, Any], text: str) -> dict[str, Any]:
        """Type ``text`` if the foreground window is still ``expected``."""
        current = self.foreground_window()
        if not _same_window(expected, current):
            raise BackendError("target_changed_since_observation")
        self._send(text_events(text))
        return self.foreground_window()

    def screen_size(self) -> tuple[int, int]:
        """Return the primary display size in physical pixels."""
        with self.pixels():
            return self.u.GetSystemMetrics(0), self.u.GetSystemMetrics(1)

    def _send(self, events: list[INPUT]) -> None:
        """Inject events, refusing if the user is holding a modifier or button.

        If only some events were accepted, the key-ups and button-ups introduced by this request
        are sent so nothing stays pressed. Input is never replayed.
        """
        if any(self.u.GetAsyncKeyState(v) & 0x8000 for v in _USER_INPUT_KEYS):
            raise BackendError("user_input_in_progress")
        array = (INPUT * len(events))(*events)
        inserted = self.u.SendInput(len(events), array, C.sizeof(INPUT))
        if inserted != len(events):
            releases = [
                e
                for e in events
                if (e.type == 1 and e.ki.dwFlags & 2) or (e.type == 0 and e.mi.dwFlags & 4)
            ]
            if inserted and releases:
                self.u.SendInput(len(releases), (INPUT * len(releases))(*releases), C.sizeof(INPUT))
            raise BackendError("input_partial_or_blocked")

    def perform(self, hwnd: int, action: Mapping[str, Any]) -> None:
        """Perform one normalised action against the Firefox window ``hwnd``.

        Supported kinds: ``focus``, ``move``, ``click``, ``key`` and ``type``. Pointer actions
        must land inside the window on a point that belongs to it.

        Raises:
            BackendError: With a specific reason such as ``target_not_frontmost``,
                ``pointer_outside_target_window``, ``target_point_occluded`` or
                ``unsupported_action``.
        """
        current = self.window(hwnd)
        kind = action["kind"]
        if kind == "focus":
            self._focus_exact(current)
            return
        if not current["frontmost"]:
            raise BackendError("target_not_frontmost")
        if kind in ("move", "click"):
            x, y = action["x"], action["y"]
            b = current["bounds"]
            if not b["x"] <= x < b["x"] + b["width"] or not b["y"] <= y < b["y"] + b["height"]:
                raise BackendError("pointer_outside_target_window")
            with self.pixels():
                at = self.u.WindowFromPoint(W.POINT(x, y))
                root = self.u.GetAncestor(at, 2)
                if root != hwnd:
                    raise BackendError("target_point_occluded")
                if not self.u.SetCursorPos(x, y):
                    raise BackendError("pointer_move_failed")
                if kind == "click":
                    if self.u.GetForegroundWindow() != hwnd:
                        raise BackendError("target_not_frontmost")
                    self._send(
                        [INPUT(type=0, mi=MOUSE(dwFlags=2)), INPUT(type=0, mi=MOUSE(dwFlags=4))]
                    )
            return
        if kind == "key":
            self._send(key_events(action["key"]))
            return
        if kind == "type":
            self._send(text_events(action["text"]))
            return
        raise BackendError("unsupported_action")

    def screenshot(self, hwnd: int, path: Path) -> dict[str, Any]:
        """Capture the frontmost Firefox window (primary display only) to a new PNG at ``path``.

        Returns:
            Metadata with the file's SHA-256, size and geometry. The file is marked private.

        Raises:
            BackendError: ``screenshot_requires_frontmost_target``,
                ``screenshot_bounds_unsupported``, ``screenshot_path_already_exists`` or a GDI
                failure code.
        """
        current = self.window(hwnd)
        if not current["frontmost"]:
            raise BackendError("screenshot_requires_frontmost_target")
        b = current["bounds"]
        x, y = b["x"], b["y"]
        width, height = b["width"], b["height"]
        screen_width, screen_height = self.screen_size()
        # Windows on the primary display only: clip the rectangle to it.
        x = max(0, x)
        y = max(0, y)
        width = min(screen_width, b["x"] + width) - x
        height = min(screen_height, b["y"] + height) - y
        if not 1 <= width <= 8192 or not 1 <= height <= 8192 or width * height > 20_000_000:
            raise BackendError("screenshot_bounds_unsupported")
        if path.exists():
            raise BackendError("screenshot_path_already_exists")
        dc = mem = bmp = old = None
        try:
            with self.pixels():
                dc = self.u.GetDC(None)
                mem = self.g.CreateCompatibleDC(dc)
                bmp = self.g.CreateCompatibleBitmap(dc, width, height)
                if not dc or not mem or not bmp:
                    raise BackendError("screenshot_gdi_unavailable")
                old = self.g.SelectObject(mem, bmp)
                # SRCCOPY | CAPTUREBLT
                if not self.g.BitBlt(mem, 0, 0, width, height, dc, x, y, 0x00CC0020 | 0x40000000):
                    raise BackendError("screenshot_copy_failed")
                self.g.SelectObject(mem, old)
                old = None
                header = BITMAPINFOHEADER(
                    size=C.sizeof(BITMAPINFOHEADER),
                    width=width,
                    height=-height,
                    planes=1,
                    bits=32,
                )
                buffer = C.create_string_buffer(width * height * 4)
                if self.g.GetDIBits(mem, bmp, 0, height, buffer, C.byref(header), 0) != height:
                    raise BackendError("screenshot_pixels_failed")
            data = png_bytes(width, height, buffer.raw)
            with path.open("xb") as out:
                out.write(data)
            return {
                "path": str(path),
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "width": width,
                "height": height,
                "screen_origin": {"x": x, "y": y},
                "coordinate_unit": "physical_pixels",
                "private": True,
            }
        finally:
            if old:
                self.g.SelectObject(mem, old)
            if bmp:
                self.g.DeleteObject(bmp)
            if mem:
                self.g.DeleteDC(mem)
            if dc:
                self.u.ReleaseDC(None, dc)
