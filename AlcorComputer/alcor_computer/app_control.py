"""Bounded, explicit-target app control built on the shared ``Computer`` runtime.

This is the "contract-bound session". A model that drives an application through
``AppController`` cannot choose or change the target application, arm the runtime, or write its
own permission. Four independent gates must all be open before one input event reaches the
backend:

1. the embedding program opted in (``live_opt_in=True``; never inferred from anything else);
2. a short-lived **grant file**, written by the account's owner and re-read for every effect,
   names this exact target and allows this kind of action, with a bounded event budget;
3. the request carries the exact id of a fresh **observation**, which is consumed by the effect,
   so stale screen coordinates cannot be replayed;
4. the backend re-checks the target's identity immediately before the event.

Every effect is written to a private receipt file *before* the backend is called (a ``pending``
record) and again afterwards (a ``terminal`` record). The same file is the cross-process writer
lease and the aggregate event ledger, so relaunching cannot reset the budget. Typed text never
appears in a receipt, only its length and SHA-256. ``public_rationale`` is a short, model-visible
decision summary, not private reasoning.

"Owner" below means the person who owns the account and the files in it. On POSIX the grant file
must be a regular file owned by that user with no group or world permissions; on Windows an
NTFS ACL check enforces the same thing (``backends.windows_private``).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import stat
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import _portable_lock as portable_lock
from .backends.base import BackendError
from .backends.macos_app import MacOSAppBackend
from .runtime import Computer, RuntimeErrorCode

GRANT_SCHEMA = "alcor.app-control.grant.v1"
OBSERVATION_SCHEMA = "alcor.app-control.observation.v1"
RECEIPT_SCHEMA = "alcor.app-control.receipt.v1"
DEFAULT_GRANT_PATH = Path.home() / ".alcor" / "app-control-grant.json"
DEFAULT_RECEIPT_PATH = Path.home() / ".alcor" / "app-control-receipts.jsonl"
ALLOWED_ACTIONS = frozenset({"focus", "key", "type", "move", "click"})
_SEMANTIC_KEY_ALIASES = {
    "arrow_up": "up",
    "arrow_down": "down",
    "arrow_left": "left",
    "arrow_right": "right",
}
# Terminal emulators are refused as targets: typing into one would recreate a general shell,
# which is exactly what this mode exists to avoid.
FORBIDDEN_TARGET_BUNDLE_IDS = frozenset(
    {
        "com.apple.terminal",
        "com.googlecode.iterm2",
        "com.mitchellh.ghostty",
        "dev.warp.warp-stable",
        "net.kovidgoyal.kitty",
        "org.alacritty",
        "org.wezfurlong.wezterm",
    }
)
# Wine-hosted programs (typically games) take input through a stricter dedicated provider. This
# generic lane must not compete for it, so any observation of such a process is refused.
RESERVED_TARGET_TOKENS = ("wine", "wine64-preloader")
MAX_SESSION_SECONDS = 300
MAX_SESSION_EVENTS = 25
MAX_OBSERVATION_AGE_MS = 5_000
MAX_PUBLIC_RATIONALE_CHARS = 280
MAX_TYPED_CHARS = 1_024
MAX_RECEIPT_STORE_BYTES = 8 * 1024 * 1024
_OBSERVATION_ID = re.compile(r"^appobs_[0-9a-f]{64}$")
_GRANT_FIELDS = frozenset(
    {
        "schema",
        "target_bundle_id",
        "issued_at",
        "expires_at",
        "max_events",
        "allowed_actions",
    }
)


class AppControlError(RuntimeError):
    """A refusal with a bounded reason code and no payload.

    Attributes:
        reason_code: Short snake_case code such as ``owner_grant_missing``.
    """

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


@dataclass(frozen=True)
class AppControlGrant:
    """A validated owner grant.

    Attributes:
        target_bundle_id: The only application the grant covers.
        issued_epoch: UTC start of validity, seconds since the epoch.
        expires_epoch: UTC end of validity, seconds since the epoch.
        max_events: How many input events the grant allows in total.
        allowed_actions: Subset of ``ALLOWED_ACTIONS`` the grant permits.
        sha256: SHA-256 of the grant file's bytes. Receipts carry it, so a changed grant is
            detected and usage is attributed to the grant that allowed it.
    """

    target_bundle_id: str
    issued_epoch: float
    expires_epoch: float
    max_events: int
    allowed_actions: frozenset[str]
    sha256: str


def _json_no_duplicates(text: str) -> Any:
    """Parse JSON, rejecting duplicate object keys (a classic way to smuggle a second value)."""

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in items:
            if key in out:
                raise AppControlError("grant_duplicate_key")
            out[key] = value
        return out

    try:
        return json.loads(text, object_pairs_hook=pairs)
    except AppControlError:
        raise
    except (TypeError, ValueError) as exc:
        raise AppControlError("grant_json_invalid") from exc


def _utc_epoch(value: Any, reason: str) -> float:
    """Parse a strict ``YYYY-MM-DDTHH:MM:SSZ`` timestamp into epoch seconds."""
    if (
        not isinstance(value, str)
        or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value) is None
    ):
        raise AppControlError(reason)
    try:
        return (
            datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        )
    except ValueError as exc:
        raise AppControlError(reason) from exc


def _private_object(info: os.stat_result, *, path: Path, descriptor: int | None = None) -> bool:
    """Return True if the file or directory is private to its owner.

    Windows checks the real NTFS ACL (mode bits mean nothing there); elsewhere the owner must be
    the current user and no group or world permission bit may be set.
    """
    if os.name == "nt":
        from .backends.windows_private import is_private

        return is_private(path, descriptor=descriptor)
    return not ((hasattr(os, "getuid") and info.st_uid != os.getuid()) or info.st_mode & 0o077)


def load_owner_grant(
    path: Path,
    *,
    target_bundle_id: str,
    now_epoch: float | None = None,
) -> AppControlGrant:
    """Read and validate one owner grant. Never creates, repairs or extends it.

    The grant is opened without following symlinks and read through the descriptor that was
    checked, so the file cannot be swapped between the privacy check and the read. It must be a
    small regular file in a private directory, a closed JSON object (no unknown or duplicate
    keys) naming ``target_bundle_id``, valid now, at most ``MAX_SESSION_SECONDS`` long, with an
    event budget of at most ``MAX_SESSION_EVENTS``.

    Args:
        path: Location of the grant file.
        target_bundle_id: The application the caller is about to control.
        now_epoch: Current time in epoch seconds; defaults to the wall clock.

    Returns:
        The validated grant.

    Raises:
        AppControlError: With a reason code such as ``owner_grant_missing``,
            ``owner_grant_permissions_too_open``, ``grant_target_mismatch``, ``grant_expired``
            or ``grant_ttl_invalid``.
    """
    target = Path(path).expanduser().absolute()
    try:
        parent = target.parent.lstat()
    except OSError as exc:
        raise AppControlError("owner_grant_parent_unavailable") from exc
    if not stat.S_ISDIR(parent.st_mode) or not _private_object(parent, path=target.parent):
        raise AppControlError("owner_grant_parent_not_private")
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(target, flags)
    except OSError as exc:
        raise AppControlError("owner_grant_missing") from exc
    try:
        info = os.fstat(descriptor)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise AppControlError("owner_grant_not_regular")
        if info.st_size < 2 or info.st_size > 8_192:
            raise AppControlError("owner_grant_size_invalid")
        if os.name != "nt" and hasattr(os, "getuid") and info.st_uid != os.getuid():
            raise AppControlError("owner_grant_owner_mismatch")
        if not _private_object(info, path=target, descriptor=descriptor):
            raise AppControlError("owner_grant_permissions_too_open")
        raw = os.read(descriptor, 8_193)
        if len(raw) != info.st_size:
            raise AppControlError("owner_grant_changed_while_reading")
    except OSError as exc:
        raise AppControlError("owner_grant_unreadable") from exc
    finally:
        os.close(descriptor)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AppControlError("grant_json_invalid") from exc
    value = _json_no_duplicates(text)
    if not isinstance(value, Mapping) or frozenset(value) != _GRANT_FIELDS:
        raise AppControlError("grant_shape_invalid")
    if value.get("schema") != GRANT_SCHEMA:
        raise AppControlError("grant_schema_invalid")
    if value.get("target_bundle_id") != target_bundle_id:
        raise AppControlError("grant_target_mismatch")
    issued = _utc_epoch(value.get("issued_at"), "grant_issued_at_invalid")
    expires = _utc_epoch(value.get("expires_at"), "grant_expires_at_invalid")
    if expires <= issued or expires - issued > MAX_SESSION_SECONDS:
        raise AppControlError("grant_ttl_invalid")
    now = time.time() if now_epoch is None else float(now_epoch)
    if issued > now + 5:
        raise AppControlError("grant_not_yet_valid")
    if expires <= now:
        raise AppControlError("grant_expired")
    max_events = value.get("max_events")
    if type(max_events) is not int or not 1 <= max_events <= MAX_SESSION_EVENTS:
        raise AppControlError("grant_event_limit_invalid")
    raw_actions = value.get("allowed_actions")
    if (
        not isinstance(raw_actions, list)
        or not raw_actions
        or any(not isinstance(item, str) for item in raw_actions)
        or len(raw_actions) != len(set(raw_actions))
    ):
        raise AppControlError("grant_actions_invalid")
    actions = frozenset(raw_actions)
    if not actions.issubset(ALLOWED_ACTIONS):
        raise AppControlError("grant_actions_invalid")
    return AppControlGrant(
        target_bundle_id=target_bundle_id,
        issued_epoch=issued,
        expires_epoch=expires,
        max_events=max_events,
        allowed_actions=actions,
        sha256=hashlib.sha256(raw).hexdigest(),
    )


def _safe_rationale(value: Any) -> str:
    """Normalise the caller's public rationale: printable, one line, at most 280 characters."""
    if not isinstance(value, str) or "\x00" in value:
        raise AppControlError("public_rationale_invalid")
    try:
        value.encode("utf-8")
    except UnicodeError as exc:
        raise AppControlError("public_rationale_invalid") from exc
    cleaned = " ".join(value.split())
    if not 1 <= len(cleaned) <= MAX_PUBLIC_RATIONALE_CHARS:
        raise AppControlError("public_rationale_invalid")
    return cleaned


def _reserved_target(value: Mapping[str, Any]) -> bool:
    """Return True if the observed process belongs to a dedicated input provider."""
    identity = " ".join(
        str(value.get(field) or "").casefold() for field in ("bundle_id", "process")
    )
    return any(token in identity for token in RESERVED_TARGET_TOKENS)


class AppController:
    """One bounded app-control episode for one explicit application target.

    Typical use is ``observe()`` followed by exactly one effect (``click``, ``type_text``,
    ``key``, ``move`` or ``focus``) that cites the observation's id; the effect consumes the
    observation and returns the next one. Every method returns a sanitised receipt dict and
    never raises for a refusal: look at ``ok`` and ``reason_code``.

    Args:
        target_bundle_id: The one application this controller may touch.
        live_opt_in: Must be True for any effect to run.
        ttl_seconds: Session lifetime, 1 to ``MAX_SESSION_SECONDS``.
        max_events: Session event budget, 1 to ``MAX_SESSION_EVENTS``. The grant's own budget
            applies too; the smaller one wins.
        max_observation_age_ms: How old an observation may be when used, 100 to 5000.
        grant_path: Where the owner's grant file lives.
        receipt_path: Private JSONL file for receipts, the writer lease and the event ledger.
        backend: The app backend. Defaults to the macOS backend for ``target_bundle_id``.
        monotonic: Monotonic clock (injectable for tests and demos).
        wall_time: Wall clock in epoch seconds (injectable for tests and demos).
        stopped: Optional callback returning True when a STOP has been requested; consulted
            before reserving an effect and again immediately before dispatch.

    Raises:
        AppControlError: For invalid arguments or a terminal-emulator target.
    """

    def __init__(
        self,
        target_bundle_id: str,
        *,
        live_opt_in: bool = False,
        ttl_seconds: int = 120,
        max_events: int = 10,
        max_observation_age_ms: int = 2_000,
        grant_path: Path = DEFAULT_GRANT_PATH,
        receipt_path: Path | None = DEFAULT_RECEIPT_PATH,
        backend: Any | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        wall_time: Callable[[], float] = time.time,
        stopped: Callable[[], bool] | None = None,
    ) -> None:
        if type(live_opt_in) is not bool:
            raise AppControlError("live_opt_in_invalid")
        if stopped is not None and not callable(stopped):
            raise AppControlError("stop_callback_invalid")
        if type(ttl_seconds) is not int or not 1 <= ttl_seconds <= MAX_SESSION_SECONDS:
            raise AppControlError("session_ttl_invalid")
        if type(max_events) is not int or not 1 <= max_events <= MAX_SESSION_EVENTS:
            raise AppControlError("session_event_limit_invalid")
        if (
            type(max_observation_age_ms) is not int
            or not 100 <= max_observation_age_ms <= MAX_OBSERVATION_AGE_MS
        ):
            raise AppControlError("observation_age_limit_invalid")
        if str(target_bundle_id).casefold() in FORBIDDEN_TARGET_BUNDLE_IDS:
            raise AppControlError("shell_app_target_forbidden")
        self.backend = backend or MacOSAppBackend(target_bundle_id)
        if getattr(self.backend, "target_bundle_id", None) != target_bundle_id:
            raise AppControlError("backend_target_mismatch")
        self.computer = Computer(self.backend)
        self.target_bundle_id = target_bundle_id
        self.live_opt_in = live_opt_in
        self.ttl_seconds = ttl_seconds
        self.max_events = max_events
        self.max_observation_age_ms = max_observation_age_ms
        self.grant_path = Path(grant_path)
        self.receipt_path = Path(receipt_path) if receipt_path is not None else None
        self._monotonic = monotonic
        self._wall_time = wall_time
        self._stopped = stopped
        self._started_monotonic = monotonic()
        self._deadline_monotonic = self._started_monotonic + ttl_seconds
        self._nonce = secrets.token_hex(16)
        self._sequence = 0
        self._events_used = 0
        self._grant_sha256: str | None = None
        self._current_observation: dict[str, Any] | None = None
        self._receipt_fd: int | None = None
        self._ambiguous_effect = False

    def close(self) -> None:
        """Release the receipt-file lease and close it. Safe to call more than once.

        On Windows the lease is a mandatory lock, so call this before reading the receipt file
        from anywhere else.
        """
        descriptor, self._receipt_fd = self._receipt_fd, None
        if descriptor is None:
            return
        try:
            portable_lock.release(descriptor)
        finally:
            os.close(descriptor)

    def __del__(self) -> None:
        # Backstop for a controller that was never closed; explicit close() is the contract.
        with contextlib.suppress(Exception):
            self.close()

    def status(self) -> dict[str, Any]:
        """Report configuration, budget use, backend status and the state of the owner grant.

        The grant is only inspected when ``live_opt_in`` is set. ``owner_grant_state`` is
        ``valid``, ``not_checked`` or the reason code of the first failed check.
        """
        backend_status = dict(self.backend.status())
        grant_state = "not_checked"
        if self.live_opt_in:
            try:
                load_owner_grant(
                    self.grant_path,
                    target_bundle_id=self.target_bundle_id,
                    now_epoch=self._wall_time(),
                )
                grant_state = "valid"
            except AppControlError as exc:
                grant_state = exc.reason_code
        return {
            "schema": "alcor.app-control.status.v1",
            "ok": bool(backend_status.get("ok")),
            "target_bundle_id": self.target_bundle_id,
            "live_opt_in": self.live_opt_in,
            "owner_grant_state": grant_state,
            "generic_shell_registered": False,
            "session_ttl_seconds": self.ttl_seconds,
            "max_events": self.max_events,
            "events_used": self._events_used,
            "max_observation_age_ms": self.max_observation_age_ms,
            "backend": backend_status,
        }

    def observe(self) -> dict[str, Any]:
        """Read the target's state and return a one-use observation.

        The returned ``observation_id`` is a hash that binds the target facts, a sequence
        number, the capture time and a per-controller nonce. It is valid for exactly one effect
        and only while younger than ``max_observation_age_ms``. Observing never fires input.
        """
        try:
            target = dict(self.backend.target_state())
        except Exception as exc:
            reason = getattr(exc, "reason_code", "target_observation_failed")
            return {
                "schema": OBSERVATION_SCHEMA,
                "ok": False,
                "target_bundle_id": self.target_bundle_id,
                "reason_code": str(reason),
                "host_input_fired": False,
            }
        captured_monotonic = self._monotonic()
        captured_epoch = self._wall_time()
        self._sequence += 1
        binding = {
            "target": target,
            "sequence": self._sequence,
            "captured_epoch_ms": int(captured_epoch * 1_000),
            "nonce": self._nonce,
        }
        observation_id = (
            "appobs_"
            + hashlib.sha256(
                json.dumps(binding, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
        )
        self._current_observation = {
            "observation_id": observation_id,
            "captured_monotonic": captured_monotonic,
            "captured_epoch_ms": binding["captured_epoch_ms"],
            "target": target,
        }
        return {
            "schema": OBSERVATION_SCHEMA,
            "ok": True,
            "observation_id": observation_id,
            "captured_epoch_ms": binding["captured_epoch_ms"],
            "target": target,
            "host_input_fired": False,
        }

    def focus(self, expected_observation_id: str, public_rationale: str) -> dict[str, Any]:
        """Bring the target application to the front. Focus is a separate, budgeted event."""
        return self._effect({"kind": "focus"}, expected_observation_id, public_rationale)

    def key(self, key: str, expected_observation_id: str, public_rationale: str) -> dict[str, Any]:
        """Press one key (or an allowlisted chord) in the target."""
        return self._effect({"kind": "key", "key": key}, expected_observation_id, public_rationale)

    def type_text(
        self, text: str, expected_observation_id: str, public_rationale: str
    ) -> dict[str, Any]:
        """Type text into the target. The receipt records only its length and SHA-256."""
        return self._effect(
            {"kind": "type", "text": text}, expected_observation_id, public_rationale
        )

    def move(
        self, x: int, y: int, expected_observation_id: str, public_rationale: str
    ) -> dict[str, Any]:
        """Move the pointer to ``(x, y)`` inside the target's window."""
        return self._effect(
            {"kind": "move", "x": x, "y": y},
            expected_observation_id,
            public_rationale,
        )

    def click(
        self, x: int, y: int, expected_observation_id: str, public_rationale: str
    ) -> dict[str, Any]:
        """Left-click at ``(x, y)`` inside the target's window."""
        return self._effect(
            {"kind": "click", "x": x, "y": y, "button": "left"},
            expected_observation_id,
            public_rationale,
        )

    def _normalize_for_runtime(self, action: Mapping[str, Any]) -> dict[str, Any]:
        """Validate the action's shape through the runtime planner (no I/O) and canonicalise it."""
        kind = action.get("kind")
        if kind == "focus":
            self.computer.plan("focus")
            return {"kind": "focus"}
        if kind == "key":
            key = action.get("key")
            self.computer.plan("key", key=key)
            key = str(key).strip().lower()
            # Translate semantic arrow names; backend key allowlists still apply afterwards.
            return {"kind": "key", "key": _SEMANTIC_KEY_ALIASES.get(key, key)}
        if kind == "type":
            text = action.get("text")
            if not isinstance(text, str) or "\x00" in text or not 1 <= len(text) <= MAX_TYPED_CHARS:
                raise AppControlError("typed_text_invalid")
            try:
                text.encode("utf-8")
            except UnicodeError as exc:
                raise AppControlError("typed_text_invalid") from exc
            self.computer.plan("type", text=text)
            return {"kind": "type", "text": text}
        if kind in {"move", "click"}:
            x, y = action.get("x"), action.get("y")
            args = {"x": x, "y": y}
            if kind == "click":
                args["button"] = "left"
            self.computer.plan(str(kind), **args)
            return {"kind": kind, **args}
        raise AppControlError("unsupported_action")

    def _effect(
        self,
        action: Mapping[str, Any],
        expected_observation_id: str,
        public_rationale: str,
    ) -> dict[str, Any]:
        """Run one effect through every gate and return its receipt.

        Order matters. Cheap, pure checks come first; the grant is read from disk only after the
        observation is accepted; a durable ``pending`` record is written before the backend is
        called; and the observation is consumed as soon as that record exists, so a crash can
        never leave a reusable binding behind.
        """
        kind = str(action.get("kind") or "")
        grant: AppControlGrant | None = None
        effect_id: str | None = None
        effect_reserved = False
        stop_refused_before_dispatch = False
        safe_action = self._safe_action_summary(action)
        try:
            rationale = _safe_rationale(public_rationale)
            normalized = self._normalize_for_runtime(action)
            stop_reason = self._stop_reason()
            if stop_reason is not None:
                raise AppControlError(stop_reason)
            if not self.live_opt_in:
                raise AppControlError("cli_live_opt_in_required")
            if self._ambiguous_effect:
                raise AppControlError("prior_effect_outcome_ambiguous")
            now_mono = self._monotonic()
            if now_mono >= self._deadline_monotonic:
                raise AppControlError("session_expired")
            if self._events_used >= self.max_events:
                raise AppControlError("session_event_limit_reached")
            if (
                not isinstance(expected_observation_id, str)
                or _OBSERVATION_ID.fullmatch(expected_observation_id) is None
            ):
                raise AppControlError("expected_observation_id_invalid")
            observed = self._current_observation
            if observed is None or observed["observation_id"] != expected_observation_id:
                raise AppControlError("fresh_observation_required")
            if _reserved_target(observed["target"]):
                raise AppControlError("dedicated_game_driver_required")
            age_ms = int((now_mono - observed["captured_monotonic"]) * 1_000)
            if age_ms < 0 or age_ms > self.max_observation_age_ms:
                raise AppControlError("observation_stale")
            # The grant is re-read every time and never cached, so revoking or editing the file
            # takes effect on the next event.
            grant = load_owner_grant(
                self.grant_path,
                target_bundle_id=self.target_bundle_id,
                now_epoch=self._wall_time(),
            )
            if self._grant_sha256 is not None and grant.sha256 != self._grant_sha256:
                raise AppControlError("owner_grant_changed")
            if kind not in grant.allowed_actions:
                raise AppControlError("owner_grant_action_denied")
            self._ensure_live_store(grant)
            event_limit = min(self.max_events, grant.max_events)
            if self._events_used >= event_limit:
                raise AppControlError("owner_grant_event_limit_reached")
            remaining = min(
                self._deadline_monotonic - now_mono,
                grant.expires_epoch - self._wall_time(),
            )
            if remaining < 1:
                raise AppControlError("owner_grant_expired")
            # First of the backend's two identity checks; perform() makes the second.
            self.backend.prepare_action(observed["target"], normalized)
            effect_id = "appeffect_" + secrets.token_hex(16)
            self._events_used += 1
            pending = self._receipt(
                ok=False,
                reason_code="effect_pending",
                rationale=rationale,
                action=safe_action,
                expected_observation_id=expected_observation_id,
                next_observation=None,
                host_input_fired=False,
                grant_sha256=grant.sha256,
                effect_id=effect_id,
                phase="pending",
                retryable=False,
            )
            if pending.get("receipt_persisted") is not True:
                self._events_used -= 1
                self.close()
                effect_id = None
                raise AppControlError("receipt_store_unavailable_before_effect")
            effect_reserved = True
            # Once a durable pending record exists, never reuse this binding. A crash before the
            # terminal record leaves a typed ambiguous hold that blocks further effects.
            self._current_observation = None
            session = self.computer.arm({kind}, ttl_seconds=max(1, min(int(remaining), 5)))
            try:
                runtime_args = dict(normalized)
                runtime_args.pop("kind", None)
                # A local policy may act repeatedly without a model turn, so read STOP again at
                # the motor boundary, after the effect is reserved.
                stop_reason = self._stop_reason()
                if stop_reason is not None:
                    stop_refused_before_dispatch = True
                    raise AppControlError(stop_reason)
                result = self.computer.execute(kind, session=session, dry_run=False, **runtime_args)
            finally:
                self.computer.disarm()
            if result.get("host_input_fired") is not True:
                self._ambiguous_effect = True
                return self._receipt(
                    ok=False,
                    reason_code="effect_outcome_ambiguous",
                    rationale=rationale,
                    action=safe_action,
                    expected_observation_id=expected_observation_id,
                    next_observation=None,
                    host_input_fired=None,
                    grant_sha256=grant.sha256,
                    effect_id=effect_id,
                    phase="terminal",
                    retryable=False,
                    effect_may_have_fired=True,
                    provider_reason_code=str(result.get("reason_code") or "effect_failed"),
                )
            self._grant_sha256 = grant.sha256
            # Every successful effect consumes the binding. The post-effect read is the only
            # observation eligible for a next action.
            self._current_observation = None
            after = self.observe()
            return self._receipt(
                ok=True,
                reason_code="performed",
                rationale=rationale,
                action=safe_action,
                expected_observation_id=expected_observation_id,
                next_observation=(after.get("observation_id") if after.get("ok") is True else None),
                host_input_fired=True,
                grant_sha256=grant.sha256,
                effect_id=effect_id,
                phase="terminal",
                retryable=False,
            )
        except (AppControlError, RuntimeErrorCode, BackendError) as exc:
            reason = getattr(exc, "reason_code", "app_control_failed")
            ambiguous = effect_reserved and not stop_refused_before_dispatch
            if ambiguous:
                self._ambiguous_effect = True
            receipt = self._receipt(
                ok=False,
                reason_code=("effect_outcome_ambiguous" if ambiguous else str(reason)),
                rationale=(
                    " ".join(str(public_rationale).split())[:MAX_PUBLIC_RATIONALE_CHARS]
                    if isinstance(public_rationale, str)
                    else ""
                ),
                action=safe_action,
                expected_observation_id=(
                    expected_observation_id
                    if isinstance(expected_observation_id, str)
                    and _OBSERVATION_ID.fullmatch(expected_observation_id)
                    else None
                ),
                next_observation=None,
                host_input_fired=None if ambiguous else False,
                grant_sha256=grant.sha256 if grant is not None else None,
                effect_id=effect_id,
                phase="terminal" if effect_reserved else "refusal",
                retryable=False if effect_reserved else None,
                effect_may_have_fired=ambiguous,
                provider_reason_code=str(reason) if ambiguous else None,
            )
            if stop_refused_before_dispatch and receipt.get("receipt_persisted") is not True:
                # No input fired, but the durable pending record is unresolved. Hold further
                # effects without changing the proven STOP verdict.
                self._ambiguous_effect = True
            return receipt

    def _stop_reason(self) -> str | None:
        """Consult the stop callback; an unreadable or malformed answer refuses input."""
        if self._stopped is None:
            return None
        try:
            stopped = self._stopped()
        except Exception:
            return "stop_check_failed"
        if type(stopped) is not bool:
            return "stop_check_failed"
        return "STOP_REQUESTED" if stopped else None

    def _ensure_live_store(self, grant: AppControlGrant) -> None:
        """Acquire the one cross-process writer lease and recover this grant's prior usage.

        The receipt file is opened without following symlinks, must be private, and is locked
        exclusively for the controller's lifetime, so two processes cannot spend one grant's
        budget in parallel. Prior records for the same grant digest are replayed to rebuild the
        event count; a torn, malformed or unresolved record fails closed.
        """
        if self._receipt_fd is not None:
            if self._grant_sha256 not in (None, grant.sha256):
                raise AppControlError("owner_grant_changed")
            return
        if self.receipt_path is None:
            raise AppControlError("receipt_store_required")
        path = self.receipt_path.expanduser().absolute()
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            parent = path.parent.lstat()
        except OSError as exc:
            raise AppControlError("receipt_store_unavailable") from exc
        if not stat.S_ISDIR(parent.st_mode) or not _private_object(parent, path=path.parent):
            raise AppControlError("receipt_store_parent_not_private")
        flags = os.O_RDWR | os.O_APPEND | os.O_CREAT
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_BINARY", 0)
        try:
            descriptor = os.open(path, flags, 0o600)
        except OSError as exc:
            raise AppControlError("receipt_store_unavailable") from exc
        acquired = False
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or not _private_object(
                info, path=path, descriptor=descriptor
            ):
                raise AppControlError("receipt_store_not_private_regular")
            try:
                portable_lock.try_exclusive(descriptor)
            except portable_lock.LockBusy as exc:
                raise AppControlError("receipt_store_busy") from exc
            acquired = True
            os.lseek(descriptor, 0, os.SEEK_END)
            size = os.lseek(descriptor, 0, os.SEEK_CUR)
            if size > MAX_RECEIPT_STORE_BYTES:
                raise AppControlError("receipt_store_too_large")
            os.lseek(descriptor, 0, os.SEEK_SET)
            remaining = size
            chunks: list[bytes] = []
            while remaining:
                chunk = os.read(descriptor, min(remaining, 1 << 20))
                if not chunk:
                    raise AppControlError("receipt_store_short_read")
                chunks.append(chunk)
                remaining -= len(chunk)
            prior = self._validated_prior_receipts(
                b"".join(chunks), grant.sha256, self.target_bundle_id
            )
            self._events_used = max(self._events_used, prior)
            self._receipt_fd = descriptor
            self._grant_sha256 = grant.sha256
        except Exception:
            if acquired:
                with contextlib.suppress(Exception):
                    portable_lock.release(descriptor)
            os.close(descriptor)
            raise

    @staticmethod
    def _validated_prior_receipts(data: bytes, grant_sha256: str, target_bundle_id: str) -> int:
        """Replay the receipt file and return how many events this grant has already used.

        Every ``pending`` record must be followed by exactly one ``terminal`` record. A
        pending record without one, or a terminal ``effect_outcome_ambiguous``, means a previous
        process may have fired input without recording the result; the store is then unusable
        until the owner resolves it.
        """
        if not data:
            return 0
        if not data.endswith(b"\n"):
            raise AppControlError("receipt_store_torn")
        pending: set[str] = set()
        terminal: set[str] = set()
        for raw_line in data.splitlines():
            try:
                row = _json_no_duplicates(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, AppControlError) as exc:
                raise AppControlError("receipt_store_malformed") from exc
            if not isinstance(row, Mapping) or row.get("schema") != RECEIPT_SCHEMA:
                raise AppControlError("receipt_store_malformed")
            digest = row.get("grant_sha256")
            if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
                raise AppControlError("receipt_store_malformed")
            if digest != grant_sha256:
                continue
            if row.get("target_bundle_id") != target_bundle_id:
                raise AppControlError("receipt_store_target_mismatch")
            phase = row.get("phase")
            effect_id = row.get("effect_id")
            if phase == "refusal" and effect_id is None:
                continue
            if (
                phase not in {"pending", "terminal"}
                or not isinstance(effect_id, str)
                or re.fullmatch(r"appeffect_[0-9a-f]{32}", effect_id) is None
            ):
                raise AppControlError("receipt_store_malformed")
            if phase == "pending":
                if effect_id in pending or effect_id in terminal:
                    raise AppControlError("receipt_store_malformed")
                pending.add(effect_id)
            else:
                if effect_id not in pending or effect_id in terminal:
                    raise AppControlError("receipt_store_malformed")
                if row.get("reason_code") == "effect_outcome_ambiguous":
                    raise AppControlError("prior_effect_outcome_ambiguous")
                terminal.add(effect_id)
        if pending - terminal:
            raise AppControlError("prior_effect_outcome_ambiguous")
        return len(pending)

    @staticmethod
    def _safe_action_summary(action: Mapping[str, Any]) -> dict[str, Any]:
        """Describe an action for receipts: typed text is reduced to its length and SHA-256."""
        kind = str(action.get("kind") or "")[:32]
        out: dict[str, Any] = {"kind": kind}
        if kind == "key":
            out["key"] = str(action.get("key") or "")[:32]
        elif kind == "type":
            text = action.get("text")
            if isinstance(text, str):
                out["text_length"] = len(text)
                out["text_sha256"] = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
        elif kind in {"move", "click"}:
            if type(action.get("x")) is int:
                out["x"] = action["x"]
            if type(action.get("y")) is int:
                out["y"] = action["y"]
        return out

    def _receipt(
        self,
        *,
        ok: bool,
        reason_code: str,
        rationale: str,
        action: Mapping[str, Any],
        expected_observation_id: str | None,
        next_observation: str | None,
        host_input_fired: bool | None,
        grant_sha256: str | None,
        effect_id: str | None,
        phase: str,
        retryable: bool | None,
        effect_may_have_fired: bool = False,
        provider_reason_code: str | None = None,
    ) -> dict[str, Any]:
        """Build a receipt and, when the lease is held, append it durably (fsync) to the store.

        If the receipt claims input fired but could not be persisted, it is rewritten as
        ``effect_outcome_ambiguous`` and the controller holds all further effects: the record of
        what happened is lost, so nothing may build on it.
        """
        row = {
            "schema": RECEIPT_SCHEMA,
            "utc": datetime.fromtimestamp(self._wall_time(), tz=timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
            "ok": ok,
            "reason_code": reason_code[:96],
            "target_bundle_id": self.target_bundle_id,
            "action": dict(action),
            "public_rationale": rationale,
            "expected_observation_id": expected_observation_id,
            "next_observation_id": next_observation,
            "events_used": self._events_used,
            "event_limit": self.max_events,
            "host_input_fired": host_input_fired,
            "typed_text_redacted": action.get("kind") != "type" or "text" not in action,
            "grant_sha256": grant_sha256,
            "effect_id": effect_id,
            "phase": phase,
        }
        if retryable is not None:
            row["retryable"] = retryable
        if effect_may_have_fired:
            row["effect_may_have_fired"] = True
        if provider_reason_code:
            row["provider_reason_code"] = provider_reason_code[:96]
        persisted = False
        if self._receipt_fd is not None and grant_sha256 is not None:
            try:
                payload = (
                    json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                    + "\n"
                ).encode("utf-8")
                while payload:
                    written = os.write(self._receipt_fd, payload)
                    if written < 1:
                        raise OSError("receipt short write")
                    payload = payload[written:]
                os.fsync(self._receipt_fd)
            except OSError:
                persisted = False
            else:
                persisted = True
        row["receipt_persisted"] = persisted
        if host_input_fired is True and not persisted:
            self._ambiguous_effect = True
            row.update(
                {
                    "ok": False,
                    "reason_code": "effect_outcome_ambiguous",
                    "host_input_fired": None,
                    "effect_may_have_fired": True,
                    "retryable": False,
                    "next_observation_id": None,
                }
            )
        return row


__all__ = [
    "ALLOWED_ACTIONS",
    "DEFAULT_GRANT_PATH",
    "DEFAULT_RECEIPT_PATH",
    "FORBIDDEN_TARGET_BUNDLE_IDS",
    "GRANT_SCHEMA",
    "OBSERVATION_SCHEMA",
    "RECEIPT_SCHEMA",
    "RESERVED_TARGET_TOKENS",
    "AppControlError",
    "AppControlGrant",
    "AppController",
    "load_owner_grant",
]
