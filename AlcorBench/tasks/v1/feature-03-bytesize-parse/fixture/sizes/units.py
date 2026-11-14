"""Byte sizes for humans: used by the backup report and the quota settings page."""

DECIMAL_UNITS = [("B", 1), ("kB", 10**3), ("MB", 10**6), ("GB", 10**9), ("TB", 10**12)]
BINARY_UNITS = [("B", 1), ("KiB", 2**10), ("MiB", 2**20), ("GiB", 2**30), ("TiB", 2**40)]


def format_size(num_bytes, binary=False):
    """1536 -> "1.5 kB" (or "1.5 KiB" with binary=True). Always one decimal above bytes."""
    if num_bytes < 0:
        raise ValueError("size cannot be negative")
    units = BINARY_UNITS if binary else DECIMAL_UNITS
    name, factor = units[0]
    for name, factor in reversed(units):
        if num_bytes >= factor:
            break
    if factor == 1:
        return "%d B" % num_bytes
    return "%.1f %s" % (num_bytes / factor, name)
