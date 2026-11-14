"""Retry delays for the payments client."""


def backoff_delays(base=0.5, factor=2.0, max_delay=8.0, attempts=5):
    """Delays in seconds before each retry: base, base*factor, ... capped at max_delay."""
    if attempts < 0:
        raise ValueError("attempts must not be negative")
    delays, delay = [], base
    for _ in range(attempts):
        delays.append(min(delay, max_delay))
        delay *= factor
    return delays
