"""Times of day as "HH:MM" strings <-> minutes since midnight."""
import re

_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$|^24:00$")


def to_minutes(hhmm):
    if not _HHMM.match(hhmm):
        raise ValueError("bad time of day: %r" % (hhmm,))
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def from_minutes(total):
    if not 0 <= total <= 24 * 60:
        raise ValueError("minutes out of range: %r" % (total,))
    return "%02d:%02d" % divmod(total, 60)
