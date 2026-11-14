"""Compare two trees and decide what a one-way sync has to do."""
from .scanner import scan


def plan(src_root, dst_root, delete=False, ignore=()):
    """List of (action, path) sorted by path.

    copy   - file exists only in src
    update - file exists in both and differs in size, or src is newer
    delete - file exists only in dst (only when delete=True)

    Paths matched by an `ignore` pattern are left out on both sides.
    """
    ignore = tuple(ignore)
    src = scan(src_root, ignore=ignore)
    dst = scan(dst_root, ignore=ignore)
    actions = []
    for path, (size, mtime) in src.items():
        if path not in dst:
            actions.append(("copy", path))
        elif dst[path][0] != size or mtime > dst[path][1]:
            actions.append(("update", path))
    if delete:
        actions.extend(("delete", path) for path in dst if path not in src)
    return sorted(actions, key=lambda item: item[1])
