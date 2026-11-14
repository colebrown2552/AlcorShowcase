"""Duration strings used in job files, e.g. `timeout = 90s`."""
import re

UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
_PATTERN = re.compile(r"(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?")


def parse_duration(text):
    """Return the number of seconds in a duration string."""
    stripped = text.strip()
    if stripped.isdigit():
        return int(stripped)
    match = _PATTERN.fullmatch(stripped)
    if not stripped or not match or not any(match.groups()):
        raise ValueError("invalid duration: %r" % (text,))
    return sum(int(n) * UNITS[u] for n, u in zip(match.groups(), "dhms") if n)
