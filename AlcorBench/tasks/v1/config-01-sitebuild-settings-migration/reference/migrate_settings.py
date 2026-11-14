"""Rewrite flat v1 site settings files into the schema 2 layout, in place."""
import copy
import json
import sys

from sitebuild.settings import DEFAULTS

V1_KEYS = {"base_url", "output_dir", "minify", "minify_exclude", "dev_host", "dev_port", "plugins"}


def _names(value):
    if isinstance(value, str):
        value = value.split(",")
    return [item.strip() for item in value if item.strip()]


def migrate(old):
    new = copy.deepcopy(DEFAULTS)
    new = {"schema": 2, **new}
    if "base_url" in old:
        new["site"]["base_url"] = old["base_url"]
    if "output_dir" in old:
        new["build"]["output"] = old["output_dir"]
    if "minify" in old:
        new["build"]["minify"]["enabled"] = old["minify"]
    if "minify_exclude" in old:
        new["build"]["minify"]["exclude"] = _names(old["minify_exclude"])
    if "dev_host" in old:
        new["serve"]["host"] = old["dev_host"]
    if "dev_port" in old:
        new["serve"]["port"] = int(old["dev_port"])
    if "plugins" in old:
        new["plugins"] = _names(old["plugins"])
    legacy = {k: v for k, v in old.items() if k not in V1_KEYS}
    if legacy:
        new["legacy"] = legacy
    return new


def process(path):
    """Return True on success, False on error (message already printed)."""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        print("error: %s: not a settings file" % path, file=sys.stderr)
        return False
    if "schema" in data:
        if data["schema"] == 2:
            print("up to date %s" % path)
            return True
        print("error: %s: unsupported schema %s" % (path, data["schema"]), file=sys.stderr)
        return False
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(migrate(data), fh, indent=2)
        fh.write("\n")
    print("migrated %s" % path)
    return True


def main(argv):
    if len(argv) < 2:
        print("usage: migrate_settings.py FILE [FILE ...]", file=sys.stderr)
        return 2
    results = [process(path) for path in argv[1:]]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
