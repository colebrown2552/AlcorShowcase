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


_FACTORS = {name.lower(): factor for name, factor in DECIMAL_UNITS + BINARY_UNITS}


def parse_size(text):
    """"1.5 GiB" -> 1610612736. Exact (decimal arithmetic), rounded down to whole bytes."""
    import re
    from decimal import Decimal

    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?|\.\d+)\s*([A-Za-z]*)\s*", text)
    if not match:
        raise ValueError("not a size: %r" % (text,))
    number, unit = match.groups()
    factor = _FACTORS.get(unit.lower() or "b")
    if factor is None:
        raise ValueError("unknown unit: %r" % (unit,))
    return int(Decimal(number) * factor)
