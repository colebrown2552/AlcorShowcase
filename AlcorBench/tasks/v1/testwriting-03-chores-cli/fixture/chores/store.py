"""JSON-file persistence for chores."""
import json
import os


def default_path():
    return os.environ.get("CHORES_FILE") or os.path.join(os.path.expanduser("~"), ".chores.json")


def load(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save(path, chores):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(chores, fh, indent=2)
    os.replace(tmp, path)


def next_id(chores):
    return max((c["id"] for c in chores), default=0) + 1


def ordered(chores):
    """Dated chores first (earliest first), then undated; ties by id."""
    return sorted(chores, key=lambda c: (c["due"] is None, c["due"] or "", c["id"]))
