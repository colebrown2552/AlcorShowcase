"""Agent configuration: configs/default.json, then a --config file, then flags.

The resolved config is the scaffold under test (prompt, sampling, budgets).
Its hash over canonical JSON lets two runs be matched by configuration.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .tasks import REPO_ROOT

DEFAULT_CONFIG_PATH = REPO_ROOT / "configs" / "default.json"
KEYS = ("system_prompt", "temperature", "max_tokens", "max_turns", "max_tool_calls",
        "command_timeout_s", "wall_time_s", "extra_body")
# Optional tool-loop options, all off by default. A key equal to its default is left out
# of the resolved config, so a config that does not use them hashes exactly as before.
OPTIONS: dict[str, object] = {
    "prefetch": False,           # context packet (file tree, named files, test command) up front
    "prefetch_bytes": 12_000,    # byte budget of that packet
    "auto_test": False,          # run the tests after each successful edit, append the result
    "finish_gate": False,        # refuse finish while the tests fail ...
    "finish_gate_repairs": 2,    # ... at most this many times
    "batch_hint": False,         # one sentence in the system prompt about parallel tool calls
    "test_command": None,        # shell command for the tests; None = detect from the files
}


# Request fields the harness sets itself; extra_body may not replace them.
RESERVED = {"model", "messages", "tools", "seed"}


class ConfigError(ValueError):
    pass


def _read(path: Path) -> dict:
    """One config file; system_prompt_file is read relative to the file."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"cannot read config {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: a config must be a JSON object")
    if "system_prompt_file" in data:
        if "system_prompt" in data:
            raise ConfigError(f"{path}: give system_prompt or system_prompt_file, not both")
        prompt_path = path.parent / data.pop("system_prompt_file")
        data["system_prompt"] = prompt_path.read_text(encoding="utf-8")
    unknown = sorted(set(data) - set(KEYS) - set(OPTIONS))
    if unknown:
        raise ConfigError(f"{path}: unknown key(s) {unknown}")
    return data


def resolve(config_file: Path | None = None, overrides: dict | None = None) -> dict:
    """Defaults, overlaid by the file, overlaid by flags that were actually given (not None)."""
    config = _read(DEFAULT_CONFIG_PATH)
    if config_file is not None:
        config.update(_read(config_file))
    config.update({k: v for k, v in (overrides or {}).items() if v is not None})
    if not isinstance(config["extra_body"], dict):
        raise ConfigError("extra_body must be a JSON object")
    clash = sorted(RESERVED & set(config["extra_body"]))
    if clash:
        raise ConfigError(f"extra_body may not set {clash}: the harness owns them")
    for key, off in OPTIONS.items():
        value = config.get(key, off)
        if isinstance(off, bool):
            ok, want = isinstance(value, bool), "true or false"
        elif isinstance(off, int):
            ok = isinstance(value, int) and not isinstance(value, bool) and value >= 0
            want = "a whole number >= 0"
        else:
            ok, want = value is None or (isinstance(value, str) and value.strip() != ""), \
                "a non-empty string or null"
        if not ok:
            raise ConfigError(f"{key} must be {want}, not {value!r}")
    resolved = {k: config[k] for k in KEYS}
    resolved.update({k: config[k] for k, off in OPTIONS.items() if config.get(k, off) != off})
    return resolved


def option(config: dict, key: str) -> object:
    """An optional setting of a resolved config, or its default when it was left out."""
    return config.get(key, OPTIONS[key])


def config_hash(config: dict) -> str:
    """SHA-256 of canonical JSON: sorted keys, no whitespace, so key order does not matter."""
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


DEFAULTS = resolve()
