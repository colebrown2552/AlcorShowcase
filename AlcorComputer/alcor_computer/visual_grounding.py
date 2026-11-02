"""Pure image/geometry binding shared by AlcorComputer and alcor_click.

This is not an input provider, goal store, perception model or permission grant.
Exact pixel equality is conservative: a dynamic scene requires re-perception.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

MAX_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 16_777_216


class GroundingError(ValueError):
    """A grounding refusal with a bounded reason code.

    Attributes:
        reason_code: Short code such as ``frame-scene-changed``.
    """

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.reason_code = code


def need(ok: bool, code: str) -> None:
    """Raise ``GroundingError(code)`` unless ``ok`` is true."""
    if not ok:
        raise GroundingError(code)


def digest(value: Any) -> str:
    """Return the SHA-256 of the canonical JSON form of ``value``."""
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
        ).encode()
    ).hexdigest()


@dataclass(frozen=True)
class VisualFrame:
    """A screenshot bound to the window it was taken of.

    Attributes:
        source_sha256: Hash of the image bytes.
        pixels_sha256: Hash of the decoded RGB pixels and size.
        target_sha256: Hash of the window description it was bound to.
        width: Image width in pixels.
        height: Image height in pixels.
        bounds: Window rectangle ``(x, y, width, height)`` in screen pixels.
        captured_monotonic: Monotonic capture time.
        image: The encoded image bytes (never shown in ``repr``).
    """

    source_sha256: str
    pixels_sha256: str
    target_sha256: str
    width: int
    height: int
    # Geometry belongs to the host's window observation, not a model reply.
    bounds: tuple[int, int, int, int]
    captured_monotonic: float
    image: bytes = field(repr=False, compare=False)

    def public(self) -> dict:
        """Return a receipt-safe description of the frame (no pixels)."""
        return {
            "schema": "alcor.computer.visual-frame.v1",
            "frame_sha256": self.source_sha256,
            "pixels_sha256": self.pixels_sha256,
            "target_sha256": self.target_sha256,
            "image_size": [self.width, self.height],
            "screen_bounds": dict(zip(("x", "y", "width", "height"), self.bounds, strict=True)),
            "coordinates": "image-pixels-to-host-screen",
            "effect_authority": False,
        }


def bind_frame(
    image: bytes, target: Mapping[str, Any], *, captured_monotonic: float
) -> VisualFrame:
    """Validate an image and bind it to a window description.

    The image must be a PNG, JPEG or PPM within the byte and pixel budgets, and its aspect
    ratio must match the window's, so a crop cannot ground a click.

    Requires Pillow.

    Raises:
        GroundingError: With a ``frame-*`` reason code.
    """
    need(type(image) is bytes and 0 < len(image) <= MAX_BYTES, "frame-byte-budget")
    need(
        type(captured_monotonic) in (int, float) and math.isfinite(captured_monotonic),
        "frame-time-invalid",
    )
    need(isinstance(target, Mapping), "frame-target-invalid")
    bounds = target.get("window_bounds", target.get("bounds"))
    need(
        type(bounds) is dict and set(bounds) == {"x", "y", "width", "height"},
        "frame-bounds-invalid",
    )
    need(all(type(bounds[k]) is int for k in bounds), "frame-bounds-type")
    x, y, w, h = (bounds[k] for k in ("x", "y", "width", "height"))
    need(
        -100000 <= x <= 100000 and -100000 <= y <= 100000 and 1 <= w <= 32768 and 1 <= h <= 32768,
        "frame-bounds-range",
    )
    from PIL import Image

    try:
        with Image.open(io.BytesIO(image)) as original:
            need(original.format in {"PNG", "JPEG", "PPM"}, "frame-format-unsupported")
            width, height = original.size
            need(0 < width * height <= MAX_PIXELS, "frame-pixel-budget")
            rgb = original.convert("RGB")
            pixel_digest = hashlib.sha256(
                width.to_bytes(4, "big") + height.to_bytes(4, "big") + rgb.tobytes()
            ).hexdigest()
    except GroundingError:
        raise
    except Exception as exc:
        raise GroundingError("frame-decode-failed") from exc
    # The screenshot must cover the full observed window. Dimensions can scale for DPI,
    # but a different aspect ratio means an unlabelled crop and cannot ground input.
    need(
        abs(width * h - height * w) <= max(width, height, w, h) * 2, "frame-window-aspect-mismatch"
    )
    return VisualFrame(
        hashlib.sha256(image).hexdigest(),
        pixel_digest,
        digest(dict(target)),
        width,
        height,
        (x, y, w, h),
        float(captured_monotonic),
        image,
    )


def image_point(frame: VisualFrame, x: int, y: int) -> dict[str, int]:
    """Map a pixel of the image to the host-screen pixel it covers.

    Pixel centres are mapped proportionally, so negative monitor origins stay valid.

    Raises:
        GroundingError: ``image-point-type`` or ``image-point-outside-frame``.
    """
    need(type(x) is int and type(y) is int, "image-point-type")
    need(0 <= x < frame.width and 0 <= y < frame.height, "image-point-outside-frame")
    bx, by, bw, bh = frame.bounds
    # Pixel centres are mapped proportionally. Negative monitor origins remain valid.
    sx = bx + min(bw - 1, int((x + 0.5) * bw / frame.width))
    sy = by + min(bh - 1, int((y + 0.5) * bh / frame.height))
    return {"x": sx, "y": sy}


def normalized_point(frame: VisualFrame, value: list[int]) -> dict[str, int]:
    """Map a ``[0, 1000]`` normalised point on the image to a host-screen pixel."""
    need(
        type(value) is list
        and len(value) == 2
        and all(type(x) is int and 0 <= x <= 1000 for x in value),
        "normalized-point-invalid",
    )
    return image_point(
        frame,
        min(frame.width - 1, value[0] * frame.width // 1000),
        min(frame.height - 1, value[1] * frame.height // 1000),
    )


def require_same_scene(
    before: VisualFrame, after: VisualFrame, *, now: float, max_age_seconds: float = 90.0
) -> None:
    """Require that two frames show the same window with identical pixels.

    Exact pixel equality is conservative on purpose: a scene that changed in any way must
    be re-perceived before a click can rely on it.

    Raises:
        GroundingError: ``frame-expired``, ``frame-time-order``,
            ``frame-target-changed`` or ``frame-scene-changed``.
    """
    need(
        type(now) in (int, float) and math.isfinite(now) and 0 < max_age_seconds <= 90,
        "frame-clock-invalid",
    )
    need(0 <= now - before.captured_monotonic <= max_age_seconds, "frame-expired")
    need(before.captured_monotonic <= after.captured_monotonic <= now, "frame-time-order")
    need(
        before.target_sha256 == after.target_sha256 and before.bounds == after.bounds,
        "frame-target-changed",
    )
    need(
        before.width == after.width
        and before.height == after.height
        and before.pixels_sha256 == after.pixels_sha256,
        "frame-scene-changed",
    )


def compare_outcome(before: VisualFrame, after: VisualFrame | None) -> dict:
    """Describe how the scene changed after an action.

    The result states only whether pixels changed. It never claims the goal was met.
    """
    if after is None:
        state = "unobserved"
    elif before.target_sha256 != after.target_sha256:
        state = "target-changed"
    else:
        state = "changed" if before.pixels_sha256 != after.pixels_sha256 else "unchanged"
    return {
        "visual_change": state,
        "expected_outcome": "not-evaluated",
        "goal_complete": False,
        "independent_verification": False,
    }
