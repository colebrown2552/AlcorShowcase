"""Do-not-disturb windows for notifications."""
from datetime import time


def in_quiet_hours(now, start=time(22, 0), end=time(7, 0)):
    """True if the time ``now`` falls in [start, end); windows may wrap midnight."""
    if start == end:
        return False
    if start < end:
        return start <= now < end
    return now >= start or now < end
