"""Walk a directory tree into {relative_path: (size, mtime_ns)}."""
import os


def scan(root):
    """Every regular file under `root`, keyed by its path relative to root with "/" separators."""
    found = {}
    for directory, subdirs, files in os.walk(root):
        subdirs.sort()
        for name in sorted(files):
            full = os.path.join(directory, name)
            if not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            info = os.stat(full)
            found[rel] = (info.st_size, info.st_mtime_ns)
    return found
