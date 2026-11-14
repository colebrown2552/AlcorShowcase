"""Walk a directory tree into {relative_path: (size, mtime_ns)}."""
import os
from fnmatch import fnmatchcase


def is_ignored(rel, ignore):
    """True if a pattern matches the whole relative path or any one component of it."""
    parts = rel.split("/")
    return any(fnmatchcase(rel, pattern) or any(fnmatchcase(part, pattern) for part in parts)
               for pattern in ignore)


def scan(root, ignore=()):
    """Every regular file under `root`, keyed by its path relative to root with "/" separators.

    Files matched by an `ignore` pattern (see is_ignored) are left out.
    """
    found = {}
    for directory, subdirs, files in os.walk(root):
        subdirs.sort()
        for name in sorted(files):
            full = os.path.join(directory, name)
            if not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if is_ignored(rel, ignore):
                continue
            info = os.stat(full)
            found[rel] = (info.st_size, info.st_mtime_ns)
    return found
