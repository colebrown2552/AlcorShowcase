"""AlcorClick: observation-bound foreground-window input for local agents.

Every effect (click, key, text, focus) must cite a fresh, single-use *observation* of the
foreground window, and the window's identity (handle, process, start time, executable, title,
bounds) is re-checked by the Win32 provider immediately before input is sent. This module owns
that freshness and binding. It does not implement raw input: the effect path is singular,

    MCP tool -> AlcorClickController -> Win32 provider (alcor_computer.backends.windows_win32)

Typed text is redacted from receipts down to its length and SHA-256. A successful effect consumes
the observation, so a caller must observe again before acting again.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import secrets
import threading
import time
from collections.abc import Callable
from functools import wraps
from pathlib import Path
from typing import Any

from alcor_computer.backends.base import BackendError

CLICK_OBSERVATION_SCHEMA = "alcor.click.observation.v1"
CLICK_RECEIPT_SCHEMA = "alcor.click.receipt.v1"
BROWSER_POINT_SCHEMA = "alcor.click.browser-point.v1"
DEFAULT_OBSERVATION_TTL_SECONDS = 45
MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024
# Windows that some other provider should drive; screenshot-grounded clicks refuse them.
RESERVED_WINDOW_WORDS = ("wine", "terminal", "powershell", "cmd.exe")


class AlcorClickError(RuntimeError):
    """A refusal with a bounded reason code.

    Attributes:
        reason_code: Short snake_case code such as ``observation_stale``.
    """

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


class WindowsClickProvider:
    """Adapter over the Win32 implementation in ``alcor_computer``.

    Args:
        api: A ``Win32`` instance or a stand-in with the same methods. Created on demand.
    """

    def __init__(self, api: Any | None = None) -> None:
        if api is None:
            from alcor_computer.backends.windows_win32 import Win32

            api = Win32()
        self.api = api

    def observe(self, screenshot_path: Path | None = None) -> dict[str, Any]:
        """Describe the foreground window and, if asked, save a screenshot of it."""
        window = dict(self.api.foreground_window())
        window["cursor"] = dict(self.api.cursor_position())
        window["coordinate_space"] = "windows_physical_screen_pixels"
        if screenshot_path is not None:
            window["screenshot"] = self._screenshot(window["bounds"], screenshot_path)
        return window

    @staticmethod
    def _screenshot(bounds: dict[str, int], path: Path) -> dict[str, Any] | None:
        """Grab the window rectangle with Pillow, or return None if Pillow is not installed."""
        try:
            from PIL import ImageGrab
        except Exception:
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        box = (
            int(bounds["x"]),
            int(bounds["y"]),
            int(bounds["x"] + bounds["width"]),
            int(bounds["y"] + bounds["height"]),
        )
        image = ImageGrab.grab(bbox=box, all_screens=True)
        image.save(path)
        data = path.read_bytes()
        return {
            "path": str(path.resolve()),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "width": image.width,
            "height": image.height,
            "private": True,
        }

    def click(self, expected: dict[str, Any], x: int, y: int) -> dict[str, Any]:
        """Left-click at ``(x, y)`` if the foreground window is still ``expected``."""
        return dict(self.api.perform_foreground_click(expected, x, y))

    def focus(self, hwnd: int) -> dict[str, Any]:
        """Foreground the window with this handle."""
        return dict(self.api.focus_window(hwnd))

    def key(self, expected: dict[str, Any], key: str) -> dict[str, Any]:
        """Press an allowlisted key chord if the foreground window is still ``expected``."""
        return dict(self.api.perform_foreground_key(expected, key))

    def type_text(self, expected: dict[str, Any], text: str) -> dict[str, Any]:
        """Type ``text`` if the foreground window is still ``expected``."""
        return dict(self.api.perform_foreground_type(expected, text))


def _serialized_observation(method: Callable[..., Any]) -> Callable[..., Any]:
    """Run controller methods one at a time: observations are consumed serially across calls."""

    @wraps(method)
    def guarded(self: AlcorClickController, *args: Any, **kwargs: Any) -> Any:
        with self._observation_lock:
            return method(self, *args, **kwargs)

    return guarded


class AlcorClickController:
    """One-observation, one-effect capability for foreground-window input.

    Every public method returns a receipt dict and never raises for a refusal; check ``ok`` and
    ``reason_code``. ``host_input_fired`` is True only if the provider reported delivery, and
    None when delivery is unknown.

    Args:
        provider: The input provider; a ``WindowsClickProvider`` by default.
        ttl_seconds: How long an observation stays usable, 1 to 300.
        monotonic: Monotonic clock (injectable for tests).
        wall_time: Wall clock (injectable for tests).
        screenshot_dir: Where observation screenshots are written; ``~/.alcor/click`` by default.

    Raises:
        AlcorClickError: ``invalid_observation_ttl``.
    """

    def __init__(
        self,
        provider: Any | None = None,
        *,
        ttl_seconds: int = DEFAULT_OBSERVATION_TTL_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
        wall_time: Callable[[], float] = time.time,
        screenshot_dir: Path | None = None,
    ) -> None:
        if type(ttl_seconds) is not int or not 1 <= ttl_seconds <= 300:
            raise AlcorClickError("invalid_observation_ttl")
        self._observation_lock = threading.RLock()
        self.provider = provider or WindowsClickProvider()
        self.ttl_seconds = ttl_seconds
        self._monotonic = monotonic
        self._wall_time = wall_time
        self._screenshot_dir = screenshot_dir or (Path.home() / ".alcor" / "click")
        self._current: dict[str, Any] | None = None

    def status(self) -> dict[str, Any]:
        """Describe the controller's platform, freshness rules and effect path."""
        return {
            "schema": "alcor.click.status.v1",
            "ok": os.name == "nt",
            "platform": os.name,
            "left_click_only": True,
            "focus_key_type_enabled": True,
            "requires_fresh_observation": True,
            "observation_ttl_seconds": self.ttl_seconds,
            "effect_path": "MCP -> AlcorClickController -> alcor_computer Win32 provider",
        }

    @staticmethod
    def _public_window(window: dict[str, Any]) -> dict[str, Any]:
        """Reduce a window description to the fields a receipt may carry.

        The process is reduced to its file name and a screenshot path to a home-relative form,
        so receipts do not reveal where things live on disk.
        """
        out = {k: window[k] for k in ("hwnd", "pid", "title", "bounds") if k in window}
        if "cursor" in window:
            out["cursor"] = window["cursor"]
        if "coordinate_space" in window:
            out["coordinate_space"] = window["coordinate_space"]
        if "screenshot" in window:
            shot = dict(window["screenshot"] or {})
            raw_path = shot.get("path")
            if isinstance(raw_path, str):
                try:
                    relative = Path(raw_path).resolve().relative_to(Path.home().resolve())
                    shot["path"] = "~/" + relative.as_posix()
                except ValueError:
                    shot["path"] = Path(raw_path).name
            out["screenshot"] = shot
        exe = window.get("exe")
        if isinstance(exe, str):
            out["process"] = Path(exe).name
        return out

    @_serialized_observation
    def get_window(self, screenshot: bool = True) -> dict[str, Any]:
        """Observe the foreground window and return a one-use ``observation_id``.

        Args:
            screenshot: Also capture the window (needs Pillow). The receipt carries its hash.
        """
        token = secrets.token_hex(16)
        shot_path = self._screenshot_dir / f"{token}.png" if screenshot else None
        try:
            window = dict(self.provider.observe(shot_path))
        except Exception as exc:
            return self._failure(getattr(exc, "reason_code", "observation_failed"))
        captured = self._monotonic()
        binding = json.dumps({"window": window, "nonce": token}, sort_keys=True, default=str)
        observation_id = "clickobs_" + hashlib.sha256(binding.encode("utf-8")).hexdigest()
        self._current = {
            "id": observation_id,
            "captured": captured,
            "window": window,
            "screenshot_path": shot_path,
        }
        return {
            "schema": CLICK_OBSERVATION_SCHEMA,
            "ok": True,
            "observation_id": observation_id,
            "captured_unix": self._wall_time(),
            "window": self._public_window(window),
            "host_input_fired": False,
        }

    @_serialized_observation
    def focus(self, hwnd: int) -> dict[str, Any]:
        """Foreground one already-running visible window by handle (invalidates the observation)."""
        if type(hwnd) is not int or hwnd < 1:
            return self._failure("invalid_window_handle")
        try:
            after = dict(self.provider.focus(hwnd))
        except (AlcorClickError, BackendError) as exc:
            return self._failure(getattr(exc, "reason_code", "focus_failed"))
        self._current = None
        return {
            "schema": CLICK_RECEIPT_SCHEMA,
            "ok": True,
            "reason_code": "performed",
            "action": {"kind": "focus", "hwnd": hwnd},
            "after": self._public_window(after),
            "host_input_fired": True,
        }

    @_serialized_observation
    def key(self, key: str, observation_id: str | None = None) -> dict[str, Any]:
        """Press one allowlisted key chord in the window named by the fresh observation."""
        return self._bound_text_action("key", key, observation_id)

    @_serialized_observation
    def type_text(self, text: str, observation_id: str | None = None) -> dict[str, Any]:
        """Type bounded printable text in the window named by the fresh observation."""
        return self._bound_text_action("type", text, observation_id)

    def _fresh_observation(self, observation_id: str | None) -> tuple[dict[str, Any] | None, str]:
        """Return the current observation if it matches and is young enough, else a reason code."""
        observed = self._current
        if observed is None:
            return None, "fresh_observation_required"
        if observation_id is not None and observation_id != observed["id"]:
            return None, "observation_id_mismatch"
        age = self._monotonic() - float(observed["captured"])
        if age < 0 or age > self.ttl_seconds:
            self._current = None
            return None, "observation_stale"
        return observed, ""

    def _bound_text_action(
        self, kind: str, value: str, observation_id: str | None
    ) -> dict[str, Any]:
        observed, reason = self._fresh_observation(observation_id)
        if observed is None:
            return self._failure(reason)
        # The observation is consumed before the provider is called, so an exception cannot
        # leave a usable binding behind.
        self._current = None
        try:
            if kind == "key":
                after = dict(self.provider.key(observed["window"], value))
            else:
                after = dict(self.provider.type_text(observed["window"], value))
        except (AlcorClickError, BackendError) as exc:
            return self._failure(getattr(exc, "reason_code", f"{kind}_failed"))
        if kind == "key":
            action = {"kind": kind, "key": value}
        else:
            action = {
                "kind": kind,
                "text_length": len(value),
                "text_sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
            }
        return {
            "schema": CLICK_RECEIPT_SCHEMA,
            "ok": True,
            "reason_code": "performed",
            "observation_id": observed["id"],
            "action": action,
            "before": self._public_window(observed["window"]),
            "after": self._public_window(after),
            "host_input_fired": True,
        }

    @_serialized_observation
    def browser_point(self, resolve: Any, observation_id: str | None = None) -> dict[str, Any]:
        """Translate a browser ``resolve(ref)`` result into physical screen pixels (read only).

        Validates that the foreground window is Chrome or Edge, that the browser's reported
        window metrics, DPI and visual-viewport scale agree with the Win32 bounds, and that the
        element centre lies inside the page, before converting it.
        """
        observed, reason = self._fresh_observation(observation_id)
        if observed is None:
            return self._failure(reason)
        try:
            translated = self._translate_browser(resolve, observed["window"])
        except AlcorClickError as exc:
            return self._failure(exc.reason_code)
        return {
            "schema": BROWSER_POINT_SCHEMA,
            "ok": True,
            "observation_id": observed["id"],
            "ref": translated["ref"],
            "point": translated["point"],
            "calibration": translated["calibration"],
            "before": self._public_window(observed["window"]),
            "host_input_fired": False,
        }

    @_serialized_observation
    def click_browser(self, resolve: Any, observation_id: str | None = None) -> dict[str, Any]:
        """Translate one browser ``resolve(ref)`` target and left-click it."""
        point = self.browser_point(resolve, observation_id)
        if point.get("ok") is not True:
            return point
        receipt = self.click(point["point"]["x"], point["point"]["y"], point["observation_id"])
        receipt["browser_ref"] = point["ref"]
        receipt["browser_calibration"] = point["calibration"]
        return receipt

    @staticmethod
    def _translate_browser(resolve: Any, window: dict[str, Any]) -> dict[str, Any]:
        """Convert a browser-reported element centre (CSS pixels) to physical screen pixels.

        Every number is range-checked, the browser's own window rectangle must match the Win32
        rectangle within a DPI-scaled tolerance, and a zoomed visual viewport is refused. The
        result is only trusted if the final point lies inside the observed window.
        """
        if not isinstance(resolve, dict) or resolve.get("ok") is not True:
            raise AlcorClickError("browser_resolve_invalid")
        center, metrics = resolve.get("center"), resolve.get("metrics")
        if not isinstance(center, dict) or not isinstance(metrics, dict):
            raise AlcorClickError("browser_resolve_invalid")

        def num(name: str, source: dict[str, Any]) -> float:
            value = source.get(name)
            if type(value) not in (int, float) or not math.isfinite(float(value)):
                raise AlcorClickError("browser_resolve_invalid")
            return float(value)

        cx, cy = num("x", center), num("y", center)
        inner_w, inner_h = num("innerWidth", metrics), num("innerHeight", metrics)
        outer_w, outer_h = num("outerWidth", metrics), num("outerHeight", metrics)
        screen_x, screen_y = num("screenX", metrics), num("screenY", metrics)
        dpr = num("devicePixelRatio", metrics)
        if not (
            0 < dpr <= 8 and 1 <= inner_w <= outer_w <= 32768 and 1 <= inner_h <= outer_h <= 32768
        ):
            raise AlcorClickError("browser_metrics_invalid")
        if not (0 <= cx < inner_w and 0 <= cy < inner_h):
            raise AlcorClickError("browser_target_offscreen")
        viewport = metrics.get("visualViewport")
        if isinstance(viewport, dict):
            scale = viewport.get("scale", 1)
            if (
                type(scale) not in (int, float)
                or not math.isfinite(float(scale))
                or abs(float(scale) - 1.0) > 0.001
            ):
                raise AlcorClickError("browser_visual_scale_unsupported")
        exe = str(window.get("exe") or "").casefold()
        if not (exe.endswith("chrome.exe") or exe.endswith("msedge.exe")):
            raise AlcorClickError("browser_window_required")
        bounds = window.get("bounds")
        if not isinstance(bounds, dict):
            raise AlcorClickError("browser_window_invalid")
        bx, by = float(bounds.get("x", 0)), float(bounds.get("y", 0))
        bw, bh = float(bounds.get("width", 0)), float(bounds.get("height", 0))
        expected = {
            "x": screen_x * dpr,
            "y": screen_y * dpr,
            "width": outer_w * dpr,
            "height": outer_h * dpr,
        }
        tolerance = max(32.0 * dpr, 0.03 * max(expected["width"], expected["height"]))
        if (
            abs(bx - expected["x"]) > tolerance
            or abs(by - expected["y"]) > tolerance
            or abs(bw - expected["width"]) > tolerance * 2
            or abs(bh - expected["height"]) > tolerance * 2
        ):
            raise AlcorClickError("browser_window_mismatch")
        # The page area sits inside the window frame: assume equal side and bottom borders and
        # attribute everything else to the top (tabs, address bar).
        side_inset = max(0.0, (outer_w - inner_w) / 2.0)
        bottom_inset = side_inset
        top_inset = max(0.0, outer_h - inner_h - bottom_inset)
        x = round((screen_x + side_inset + cx) * dpr)
        y = round((screen_y + top_inset + cy) * dpr)
        if not (bx <= x < bx + bw and by <= y < by + bh):
            raise AlcorClickError("browser_point_outside_window")
        return {
            "ref": str(resolve.get("ref") or "")[:128],
            "point": {"x": x, "y": y},
            "calibration": {
                "device_pixel_ratio": dpr,
                "side_inset_css": side_inset,
                "top_inset_css": top_inset,
                "browser_screen_css": {"x": screen_x, "y": screen_y},
            },
        }

    @staticmethod
    def _visual_target(window: dict[str, Any]) -> dict[str, Any]:
        """The identity fields that bind a screenshot to a window.

        The cursor position and the private screenshot path are not window identity.
        """
        keys = ("hwnd", "pid", "started", "exe", "title", "bounds", "coordinate_space")
        return {k: window[k] for k in keys if k in window}

    def _image_frame(self, observation_id: str, screenshot_sha256: str) -> Any:
        """Re-read the observation's screenshot from disk and bind it to the observed window."""
        from alcor_computer.visual_grounding import GroundingError, bind_frame

        observed = self._current
        if observed is None:
            raise GroundingError("fresh_observation_required")
        if observation_id != observed["id"]:
            raise GroundingError("observation_id_mismatch")
        age = self._monotonic() - observed["captured"]
        if not 0 <= age <= self.ttl_seconds:
            raise GroundingError("observation_stale")
        shot = observed["window"].get("screenshot") or {}
        path = observed.get("screenshot_path")
        if (
            not isinstance(screenshot_sha256, str)
            or len(screenshot_sha256) != 64
            or shot.get("sha256") != screenshot_sha256
            or path is None
            or path.is_symlink()
            or not path.is_file()
            or path.stat().st_size > MAX_SCREENSHOT_BYTES
        ):
            raise GroundingError("screenshot_binding_missing")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != screenshot_sha256:
            raise GroundingError("screenshot_bytes_changed")
        return bind_frame(
            raw, self._visual_target(observed["window"]), captured_monotonic=observed["captured"]
        )

    @_serialized_observation
    def image_point(
        self, x: int, y: int, observation_id: str, screenshot_sha256: str
    ) -> dict[str, Any]:
        """Translate a pixel of the observed screenshot into a host-screen point (read only)."""
        from alcor_computer.visual_grounding import image_point

        try:
            frame = self._image_frame(observation_id, screenshot_sha256)
            point = image_point(frame, x, y)
        except Exception as exc:
            return self._failure(getattr(exc, "reason_code", "image_grounding_failed"))
        return {
            "schema": "alcor.click.image-point.v1",
            "ok": True,
            "point": point,
            "observation_id": observation_id,
            "frame": frame.public(),
            "host_input_fired": False,
        }

    @_serialized_observation
    def click_image(
        self, x: int, y: int, observation_id: str, screenshot_sha256: str
    ) -> dict[str, Any]:
        """Click one screenshot-grounded point, only if the scene is still pixel-identical.

        A fresh screenshot is taken immediately before the click and must equal the observed one.
        Any difference means the scene changed and the caller must re-observe. The observation is
        consumed by the attempt, a failure after dispatch reports unknown delivery, and nothing is
        ever retried automatically.
        """
        from alcor_computer.visual_grounding import (
            bind_frame,
            compare_outcome,
            image_point,
            require_same_scene,
        )

        dispatched = False
        try:
            frame = self._image_frame(observation_id, screenshot_sha256)
            old = self._current
            self._current = None  # every attempted grounded effect consumes its observation
            point = image_point(frame, x, y)
            identity = str(old["window"].get("exe", "")).lower()
            if any(word in identity for word in RESERVED_WINDOW_WORDS):
                raise AlcorClickError("dedicated_input_path_required")
            path = self._screenshot_dir / (secrets.token_hex(16) + ".png")
            current = dict(self.provider.observe(path))
            if (
                path.is_symlink()
                or not path.is_file()
                or path.stat().st_size > MAX_SCREENSHOT_BYTES
            ):
                raise AlcorClickError("fresh_screenshot_unavailable")
            fresh = bind_frame(
                path.read_bytes(),
                self._visual_target(current),
                captured_monotonic=self._monotonic(),
            )
            require_same_scene(
                frame, fresh, now=self._monotonic(), max_age_seconds=min(90, self.ttl_seconds)
            )
            dispatched = True
            after = dict(self.provider.click(current, point["x"], point["y"]))
        except Exception as exc:
            failed = self._failure(getattr(exc, "reason_code", "image_click_failed"))
            if dispatched:
                failed["host_input_fired"] = None
                failed["delivery"] = "unknown"
            failed["automatic_retry"] = False
            return failed
        # Delivery is a provider receipt, not a semantic goal result, so the after-picture is
        # best effort and only described, never judged.
        try:
            path = self._screenshot_dir / (secrets.token_hex(16) + ".png")
            post_window = dict(self.provider.observe(path))
            if path.is_symlink() or path.stat().st_size > MAX_SCREENSHOT_BYTES:
                raise AlcorClickError("post_screenshot_invalid")
            post = bind_frame(
                path.read_bytes(),
                self._visual_target(post_window),
                captured_monotonic=self._monotonic(),
            )
        except Exception:
            post = None
        return {
            "schema": CLICK_RECEIPT_SCHEMA,
            "ok": True,
            "reason_code": "performed",
            "observation_id": observation_id,
            "action": {"kind": "click", **point, "button": "left"},
            "frame": frame.public(),
            "after_frame": post.public() if post else None,
            "outcome": compare_outcome(frame, post),
            "after": self._public_window(after),
            "host_input_fired": True,
            "automatic_retry": False,
        }

    @_serialized_observation
    def click(self, x: int, y: int, observation_id: str | None = None) -> dict[str, Any]:
        """Left-click ``(x, y)`` in the window named by the fresh observation."""
        if type(x) is not int or type(y) is not int:
            return self._failure("invalid_coordinates")
        observed, reason = self._fresh_observation(observation_id)
        if observed is None:
            return self._failure(reason)
        self._current = None
        try:
            after = dict(self.provider.click(observed["window"], x, y))
        except (AlcorClickError, BackendError) as exc:
            return self._failure(getattr(exc, "reason_code", "click_failed"), x=x, y=y)
        except Exception:
            return self._failure("click_failed", x=x, y=y)
        return {
            "schema": CLICK_RECEIPT_SCHEMA,
            "ok": True,
            "reason_code": "performed",
            "observation_id": observed["id"],
            "action": {"kind": "click", "x": x, "y": y, "button": "left"},
            "before": self._public_window(observed["window"]),
            "after": self._public_window(after),
            "host_input_fired": True,
        }

    @staticmethod
    def _failure(reason: str, *, x: int | None = None, y: int | None = None) -> dict[str, Any]:
        """Build a refusal receipt; input never fired."""
        value: dict[str, Any] = {
            "schema": CLICK_RECEIPT_SCHEMA,
            "ok": False,
            "reason_code": str(reason),
            "host_input_fired": False,
        }
        if x is not None and y is not None:
            value["action"] = {"kind": "click", "x": x, "y": y, "button": "left"}
        return value


__all__ = ["AlcorClickController", "AlcorClickError", "WindowsClickProvider"]
