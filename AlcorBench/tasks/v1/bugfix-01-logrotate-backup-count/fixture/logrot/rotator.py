"""Size-based log rotation.

``rotate(path, backup_count)`` renames ``app.log`` to ``app.log.1`` after
shifting the older backups up by one (``app.log.1`` -> ``app.log.2`` and so
on), then starts a fresh empty ``app.log``. At most ``backup_count`` backups
are kept: anything that would be numbered higher is discarded. With
``backup_count == 0`` the log is simply truncated and no backups are kept.
"""
import os


def backup_name(path, index):
    return f"{path}.{index}"


def existing_backups(path):
    """Return the indexes of the backups of ``path`` that exist, ascending."""
    directory = os.path.dirname(path) or "."
    prefix = os.path.basename(path) + "."
    found = []
    for name in os.listdir(directory):
        suffix = name[len(prefix):]
        if name.startswith(prefix) and suffix.isdigit():
            found.append(int(suffix))
    return sorted(found)


def should_rotate(path, max_bytes):
    try:
        return os.path.getsize(path) >= max_bytes
    except FileNotFoundError:
        return False


def rotate(path, backup_count):
    if not os.path.exists(path):
        return
    if backup_count <= 0:
        open(path, "w").close()
        return

    # Anything already beyond the limit (e.g. after lowering backup_count)
    # is removed first.
    for index in existing_backups(path):
        if index > backup_count:
            os.remove(backup_name(path, index))

    # Shift the remaining backups up by one, oldest first, so nothing is
    # overwritten before it has been moved.
    for index in reversed(range(1, backup_count - 1)):
        src = backup_name(path, index)
        if os.path.exists(src):
            os.replace(src, backup_name(path, index + 1))

    os.replace(path, backup_name(path, 1))
    open(path, "w").close()


def append_line(path, line, max_bytes, backup_count):
    """Append ``line`` to ``path``, rotating first if the file is full."""
    if should_rotate(path, max_bytes):
        rotate(path, backup_count)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line.rstrip("\n") + "\n")
