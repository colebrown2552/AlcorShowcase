"""Operator settings: who may call, which extension may attach, and where uploads may read from.

Nothing that identifies one installation is written into the code. It lives in ``config.json`` in
the broker home, with environment variables overriding the file for one-off runs. Every value is
validated when it is loaded, and the broker refuses to start on a bad one: a typo in an allowlist
should stop the process, not quietly widen it.

``config.json`` keys (all optional)::

    {
      "agents": ["agent-a", "agent-b"],       # one bearer token per name
      "extension_id": "<32 letters a-p>",     # from chrome://extensions after "Load unpacked"
      "upload_dirs": ["C:/path/to/uploads"],  # browser_upload may read only inside these
      "update_channel": "",                   # a directory path or an https URL; empty = no updates
      "update_interval_s": 600
    }
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import update_channel

#: Used when ``agents`` is not configured. Two names, so the demo can show per-agent tokens.
DEFAULT_AGENTS = ("agent-a", "agent-b")
#: Token files the broker keeps for itself; an agent may not take these names.
RESERVED_NAMES = frozenset({"extension", "admin"})
DEFAULT_UPDATE_INTERVAL_S = 600.0
MAX_AGENTS = 16

# Agent names become file names (state/agents/<name>.token), so the pattern also blocks path tricks.
_AGENT_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")
# Chrome derives extension ids from a hash and writes them with the letters a-p only.
_EXTENSION_ID = re.compile(r"[a-p]{32}")


class ConfigError(ValueError):
    """The configuration is invalid; the message names the offending field."""


@dataclass(frozen=True)
class Settings:
    """Validated broker settings.

    Attributes:
        agents: Names that may call ``/mcp``, each with its own token file.
        extension_id: The one extension allowed to fetch upload tickets; empty until configured.
        upload_dirs: Directories ``browser_upload`` may read from. Empty disables uploads.
        update_channel: A directory path or https URL, or empty for no update source.
        update_interval_s: Seconds between background update checks.
    """

    agents: tuple[str, ...] = DEFAULT_AGENTS
    extension_id: str = ""
    upload_dirs: tuple[Path, ...] = ()
    update_channel: str = ""
    update_interval_s: float = DEFAULT_UPDATE_INTERVAL_S


def default_home(environ: Mapping[str, str] | None = None) -> Path:
    """Return the broker home: ``ALCOR_BROWSER_HOME``, else a per-user folder.

    Args:
        environ: Environment to read; defaults to the process environment.

    Returns:
        The directory holding ``config.json``, ``state/``, ``runtime/`` and extension copies.
    """
    env = os.environ if environ is None else environ
    if env.get("ALCOR_BROWSER_HOME"):
        return Path(env["ALCOR_BROWSER_HOME"])
    if os.name == "nt":
        return Path(env.get("LOCALAPPDATA") or Path.home()) / "AlcorBrowser"
    return Path.home() / ".alcor-browser"


def load_settings(home: Path, environ: Mapping[str, str] | None = None) -> Settings:
    """Read and validate ``config.json`` from ``home``, then apply environment overrides.

    Args:
        home: The broker home directory.
        environ: Environment to read; defaults to the process environment.

    Returns:
        The validated settings. A missing file gives the defaults.

    Raises:
        ConfigError: If the file is unreadable or any value is invalid.
    """
    env = os.environ if environ is None else environ
    path = Path(env.get("ALCOR_BROWSER_CONFIG") or Path(home) / "config.json")
    raw: dict = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ConfigError(f"{path.name} is not readable JSON: {exc}") from exc
        if not isinstance(loaded, dict):
            raise ConfigError(f"{path.name} must hold a JSON object")
        raw = loaded

    channel = str(env.get("ALCOR_BROWSER_CHANNEL") or raw.get("update_channel") or "")
    if channel:
        try:
            update_channel.open_source(channel)
        except update_channel.ChannelError as exc:
            raise ConfigError(f"update_channel: {exc}") from exc
    extension_id = env.get("ALCOR_BROWSER_EXTENSION_ID") or raw.get("extension_id")
    interval = env.get("ALCOR_BROWSER_UPDATE_INTERVAL_S") or raw.get("update_interval_s")
    return Settings(
        agents=_agents(raw.get("agents", DEFAULT_AGENTS)),
        extension_id=check_extension_id(extension_id),
        # The default is a demo folder inside the home: uploads work out of the box but cannot
        # reach anything else on the machine until the operator widens the list.
        upload_dirs=_upload_dirs(raw.get("upload_dirs"), default=Path(home) / "uploads"),
        update_channel=channel,
        update_interval_s=_interval(interval),
    )


def _agents(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)) or not 1 <= len(value) <= MAX_AGENTS:
        raise ConfigError(f"agents: give 1 to {MAX_AGENTS} names")
    names = []
    for item in value:
        if not isinstance(item, str) or not _AGENT_NAME.fullmatch(item):
            raise ConfigError("agents: names are lowercase letters, digits, '-' and '_' (max 32)")
        if item in RESERVED_NAMES:
            raise ConfigError(f"agents: '{item}' is reserved")
        if item in names:
            raise ConfigError(f"agents: duplicate name '{item}'")
        names.append(item)
    return tuple(names)


def check_extension_id(value: object) -> str:
    """Validate an extension id as shown on chrome://extensions.

    Args:
        value: The id; empty or None means "not configured yet".

    Returns:
        The id as text ("" when not configured).

    Raises:
        ConfigError: If it is not 32 letters a-p.
    """
    text = str(value or "")
    if text and not _EXTENSION_ID.fullmatch(text):
        raise ConfigError("extension_id: expected 32 letters a-p, as shown on chrome://extensions")
    return text


def _upload_dirs(value: object, default: Path) -> tuple[Path, ...]:
    if value is None:
        return (default,)
    if not isinstance(value, (list, tuple)):
        raise ConfigError("upload_dirs: expected a list of absolute directory paths")
    dirs = []
    for item in value:
        path = Path(str(item)).expanduser()
        if not path.is_absolute():
            raise ConfigError("upload_dirs: every entry must be an absolute path")
        dirs.append(path)
    return tuple(dirs)


def _interval(value: object) -> float:
    if value in (None, ""):
        return DEFAULT_UPDATE_INTERVAL_S
    try:
        seconds = float(str(value))
    except ValueError as exc:
        raise ConfigError("update_interval_s: expected a number of seconds") from exc
    if seconds < 1:
        raise ConfigError("update_interval_s: must be at least 1")
    return seconds
