"""Settings: one JSON file plus environment variables, with neutral defaults under ``./.sitekit``.

Precedence, highest first: environment variable (``SITEKIT_<NAME>``), config file, default.
Relative paths in the config file resolve against the file's folder; relative paths in the
environment resolve against the current folder. An unknown key in the file is an error, because a
typo that is silently ignored turns into a missing setting later.

The config file is found through ``SITEKIT_CONFIG``, then ``<home>/config.json``. Nothing here
carries a default host name, user or server path: URLs have no default and the commands that need
one say which setting to give.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_PATH_KEYS = (
    "staging_dir",
    "production_dir",
    "repo_dir",
    "controller_dir",
    "contract_file",
    "intended_file",
)
_TEXT_KEYS = ("staging_url", "production_url", "transport")
_LIST_KEYS = ("smoke_pages", "pages", "unserved")
_NUMBER_KEYS = ("poll_seconds", "wait_seconds")
KNOWN_KEYS = frozenset(_PATH_KEYS + _TEXT_KEYS + _LIST_KEYS + _NUMBER_KEYS)


class ConfigError(Exception):
    """Raised when settings are unreadable, unknown or incomplete."""


@dataclass(frozen=True)
class Config:
    """Resolved settings for one run."""

    home: Path
    staging_url: str
    production_url: str
    staging_dir: Path
    production_dir: Path
    repo_dir: Path
    controller_dir: Path
    contract_file: Path
    intended_file: Path | None
    smoke_pages: tuple[str, ...]
    pages: tuple[str, ...]
    unserved: tuple[str, ...]
    transport: str
    poll_seconds: float
    wait_seconds: float

    @property
    def receipts(self) -> Path:
        """Folder of contract receipts for staging."""
        return self.home / "receipts"

    @property
    def jobs(self) -> Path:
        """Folder of detached job records."""
        return self.home / "jobs"

    @property
    def hold_file(self) -> Path:
        """The file whose existence freezes ``promote --go``."""
        return self.home / "PROMOTE_HOLD"

    def require(self, name: str) -> str:
        """Return a URL setting, or fail with the name of the setting to provide.

        Raises:
            ConfigError: if the setting is empty or is not an http(s) URL.
        """
        value = str(getattr(self, name))
        if not value:
            raise ConfigError(
                f"{name} is not set: put it in the config file or SITEKIT_{name.upper()}"
            )
        if not value.startswith(("http://", "https://")):
            raise ConfigError(f"{name} must be an http:// or https:// URL")
        return value.rstrip("/")


def _split(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split(",") if part.strip())


def load_config(config_path: str | None = None, env: Mapping[str, str] | None = None) -> Config:
    """Resolve settings from the environment, the config file and the defaults.

    Args:
        config_path: explicit config file; otherwise ``SITEKIT_CONFIG`` or ``<home>/config.json``.
        env: environment to read (defaults to ``os.environ``); a parameter so callers can isolate.

    Raises:
        ConfigError: if the config file cannot be read, has unknown keys or has a bad value.
    """
    env = os.environ if env is None else env
    home = Path(env.get("SITEKIT_HOME", ".sitekit")).expanduser().resolve()
    file_path = config_path or env.get("SITEKIT_CONFIG")
    if not file_path and (home / "config.json").is_file():
        file_path = str(home / "config.json")
    data: dict[str, Any] = {}
    base = Path.cwd()
    if file_path:
        path = Path(file_path).expanduser().resolve()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ConfigError(f"cannot read config file {path.name}: {error}") from error
        if not isinstance(data, dict):
            raise ConfigError("the config file must hold one JSON object")
        unknown = sorted(set(data) - KNOWN_KEYS)
        if unknown:
            raise ConfigError(f"unknown setting(s) in {path.name}: {', '.join(unknown)}")
        base = path.parent

    def env_value(key: str) -> str | None:
        return env.get(f"SITEKIT_{key.upper()}") or None

    def path_of(key: str, default: Path | None) -> Path | None:
        if (text := env_value(key)) is not None:
            return Path(text).expanduser().resolve()
        if key in data:
            return (base / Path(str(data[key])).expanduser()).resolve()
        return default

    def text_of(key: str, default: str) -> str:
        return env_value(key) or str(data.get(key, default))

    def list_of(key: str, default: tuple[str, ...]) -> tuple[str, ...]:
        if (text := env_value(key)) is not None:
            return _split(text)
        value = data.get(key, default)
        if not isinstance(value, (list, tuple)):
            raise ConfigError(f"{key} must be a list of strings")
        return tuple(str(item) for item in value)

    def number_of(key: str, default: float) -> float:
        try:
            return float(env_value(key) or data.get(key, default))
        except (TypeError, ValueError) as error:
            raise ConfigError(f"{key} must be a number") from error

    package_root = Path(__file__).resolve().parents[1]
    return Config(
        home=home,
        staging_url=text_of("staging_url", ""),
        production_url=text_of("production_url", ""),
        staging_dir=path_of("staging_dir", home / "hosts" / "staging") or home,
        production_dir=path_of("production_dir", home / "hosts" / "production") or home,
        repo_dir=path_of("repo_dir", home / "repo") or home,
        controller_dir=path_of("controller_dir", home / "controller") or home,
        contract_file=path_of("contract_file", package_root / "contract.json") or package_root,
        intended_file=path_of("intended_file", None),
        smoke_pages=list_of("smoke_pages", ("/",)),
        pages=list_of("pages", ()),
        unserved=list_of("unserved", ()),
        transport=text_of("transport", "directory"),
        poll_seconds=number_of("poll_seconds", 5.0),
        wait_seconds=number_of("wait_seconds", 900.0),
    )
