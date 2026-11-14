"""Load site settings (schema 2)."""
import copy
import json

DEFAULTS = {
    "site": {"base_url": "/"},
    "build": {"output": "public", "minify": {"enabled": False, "exclude": []}},
    "serve": {"host": "127.0.0.1", "port": 4000},
    "plugins": [],
}


def _merge(base, override):
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = value
    return base


def load_settings(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("schema") != 2:
        raise ValueError("%s: settings use the old layout; run migrate_settings.py" % path)
    settings = copy.deepcopy(DEFAULTS)
    return _merge(settings, {k: v for k, v in data.items() if k != "schema"})
