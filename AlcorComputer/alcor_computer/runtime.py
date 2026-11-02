"""Shared AlcorComputer runtime entrypoint for macOS and Windows.

The runtime is dry-run by default. Host mutation requires an explicit,
process-local arm session; environment variables and serialized data cannot arm
it. Backends are injected or selected lazily by platform name.
"""

from __future__ import annotations

import hashlib
import platform
import secrets
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

RUNTIME_SCHEMA = "alcor.computer.runtime.v1"
RECEIPT_SCHEMA = "alcor.computer.runtime.receipt.v1"
_ALLOWED_ACTIONS = frozenset({"focus", "move", "click", "type", "key"})
_MAX_ARM_SECONDS = 300
_MAX_TEXT_CHARS = 4096


class RuntimeErrorCode(RuntimeError):
    """A runtime refusal with a bounded reason code.

    Attributes:
        reason_code: Short snake_case code such as ``not_armed``.
    """

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


@dataclass(frozen=True)
class ArmSession:
    """Opaque process-local capability. Its secret is intentionally not printable."""

    instance_id: str
    allowed_actions: frozenset[str]
    expires_monotonic: float
    _secret: str = field(repr=False)


class Computer:
    """One Python interface for a local macOS, Windows, or custom machine backend."""

    def __init__(self, backend: Any | None = None, *, platform_name: str | None = None) -> None:
        self._instance_id = secrets.token_hex(16)
        self._arm_secret_hash: str | None = None
        self._arm_expires = 0.0
        self._arm_actions: frozenset[str] = frozenset()
        self.backend = backend if backend is not None else self._select_backend(platform_name)

    @staticmethod
    def _select_backend(platform_name: str | None) -> Any:
        name = (platform_name or platform.system()).strip().lower()
        if name in {"darwin", "mac", "macos"}:
            from .backends.macos import MacOSBackend

            return MacOSBackend()
        if name in {"windows", "win32", "win"}:
            from .backends.windows import WindowsBackend

            return WindowsBackend()
        raise RuntimeErrorCode("unsupported_platform")

    @property
    def platform_name(self) -> str:
        """Return the backend's label, or ``custom``."""
        return str(getattr(self.backend, "name", "custom"))

    def status(self) -> dict[str, Any]:
        """Report the backend status and whether a live arm is active."""
        try:
            backend_status = dict(self.backend.status())
            backend_ok = bool(backend_status.get("ok", True))
        except Exception:
            backend_status = {"ok": False, "reason_code": "backend_status_failed"}
            backend_ok = False
        return {
            "schema": RUNTIME_SCHEMA,
            "ok": backend_ok,
            "platform": self.platform_name,
            "shared_interface": True,
            "dry_run_default": True,
            "armed": self._arm_is_live(),
            "backend": backend_status,
        }

    def observe(self, *, screenshot_path: str | None = None) -> dict[str, Any]:
        """Return normalized local observation metadata; screenshot bytes stay local."""
        try:
            width, height = self.backend.screen_size()
            foreground = dict(self.backend.foreground_window())
            shot = (
                None if screenshot_path is None else dict(self.backend.screenshot(screenshot_path))
            )
            return {
                "schema": RECEIPT_SCHEMA,
                "ok": True,
                "operation": "observe",
                "platform": self.platform_name,
                "screen": {"width": int(width), "height": int(height)},
                "foreground": foreground,
                "screenshot": shot,
                "host_input_fired": False,
            }
        except Exception as exc:
            return self._failure("observe", getattr(exc, "reason_code", "observe_failed"))

    def plan(self, action: str, **kwargs: Any) -> dict[str, Any]:
        """Validate and normalise an action without performing it.

        Raises:
            RuntimeErrorCode: ``unsupported_action``, ``unknown_action_field``,
                ``invalid_coordinates``, ``unsupported_button``, ``invalid_text`` or
                ``invalid_key``.
        """
        normalized = self._normalize_action(action, kwargs)
        return {
            "schema": RECEIPT_SCHEMA,
            "ok": True,
            "operation": "plan",
            "platform": self.platform_name,
            "action": normalized,
            "dry_run": True,
            "host_input_fired": False,
        }

    def arm(
        self,
        actions: tuple[str, ...] | list[str] | set[str] = tuple(_ALLOWED_ACTIONS),
        *,
        ttl_seconds: int = 60,
    ) -> ArmSession:
        """Create one bounded process-local capability; calling arm replaces the prior one."""
        if type(ttl_seconds) is not int or ttl_seconds < 1 or ttl_seconds > _MAX_ARM_SECONDS:
            raise RuntimeErrorCode("invalid_arm_ttl")
        allowed = frozenset(str(a).strip().lower() for a in actions)
        if not allowed or not allowed.issubset(_ALLOWED_ACTIONS):
            raise RuntimeErrorCode("invalid_arm_scope")
        secret = secrets.token_hex(32)
        expires = time.monotonic() + ttl_seconds
        self._arm_secret_hash = hashlib.sha256(secret.encode("ascii")).hexdigest()
        self._arm_expires = expires
        self._arm_actions = allowed
        return ArmSession(self._instance_id, allowed, expires, secret)

    def disarm(self) -> None:
        """Drop any live arm immediately."""
        self._arm_secret_hash = None
        self._arm_expires = 0.0
        self._arm_actions = frozenset()

    def execute(
        self, action: str, *, session: ArmSession | None = None, dry_run: bool = True, **kwargs: Any
    ) -> dict[str, Any]:
        """Plan by default; only an explicit live arm plus dry_run=False reaches a backend."""
        try:
            normalized = self._normalize_action(action, kwargs)
        except RuntimeErrorCode as exc:
            return self._failure("execute", exc.reason_code)
        if dry_run:
            return {
                "schema": RECEIPT_SCHEMA,
                "ok": True,
                "operation": "execute",
                "platform": self.platform_name,
                "action": normalized,
                "dry_run": True,
                "host_input_fired": False,
                "reason_code": "dry_run",
            }
        reason = self._arm_reason(session, normalized["kind"])
        if reason is not None:
            return self._failure("execute", reason)
        try:
            self.backend.perform(normalized)
        except Exception as exc:
            return self._failure("execute", getattr(exc, "reason_code", "backend_action_failed"))
        return {
            "schema": RECEIPT_SCHEMA,
            "ok": True,
            "operation": "execute",
            "platform": self.platform_name,
            "action_kind": normalized["kind"],
            "dry_run": False,
            "host_input_fired": True,
            "reason_code": "performed",
        }

    def _normalize_action(self, action: str, args: Mapping[str, Any]) -> dict[str, Any]:
        name = str(action or "").strip().lower()
        if name not in _ALLOWED_ACTIONS:
            raise RuntimeErrorCode("unsupported_action")
        if name == "focus":
            if args:
                raise RuntimeErrorCode("unknown_action_field")
            return {"kind": "focus"}
        if name in {"move", "click"}:
            if frozenset(args) - ({"x", "y"} if name == "move" else {"x", "y", "button"}):
                raise RuntimeErrorCode("unknown_action_field")
            x, y = args.get("x"), args.get("y")
            if type(x) is not int or type(y) is not int or x < 0 or y < 0:
                raise RuntimeErrorCode("invalid_coordinates")
            out = {"kind": name, "x": x, "y": y}
            if name == "click":
                button = str(args.get("button", "left")).lower()
                if button != "left":
                    raise RuntimeErrorCode("unsupported_button")
                out["button"] = button
            return out
        if name == "type":
            if (
                frozenset(args) != {"text"}
                or not isinstance(args.get("text"), str)
                or len(args["text"]) > _MAX_TEXT_CHARS
            ):
                raise RuntimeErrorCode("invalid_text")
            return {"kind": "type", "text": args["text"]}
        if frozenset(args) != {"key"} or not isinstance(args.get("key"), str):
            raise RuntimeErrorCode("invalid_key")
        key = args["key"].strip().lower()
        if not key or len(key) > 32:
            raise RuntimeErrorCode("invalid_key")
        return {"kind": "key", "key": key}

    def _arm_is_live(self) -> bool:
        return self._arm_secret_hash is not None and time.monotonic() < self._arm_expires

    def _arm_reason(self, session: ArmSession | None, action: str) -> str | None:
        if session is None or session.instance_id != self._instance_id:
            return "not_armed"
        if not self._arm_is_live() or time.monotonic() >= session.expires_monotonic:
            return "arm_expired"
        supplied = hashlib.sha256(session._secret.encode("ascii")).hexdigest()
        if not secrets.compare_digest(supplied, self._arm_secret_hash or ""):
            return "invalid_arm"
        if action not in self._arm_actions or action not in session.allowed_actions:
            return "arm_scope_denied"
        return None

    def _failure(self, operation: str, reason_code: str) -> dict[str, Any]:
        return {
            "schema": RECEIPT_SCHEMA,
            "ok": False,
            "operation": operation,
            "platform": self.platform_name,
            "reason_code": str(reason_code),
            "host_input_fired": False,
        }
