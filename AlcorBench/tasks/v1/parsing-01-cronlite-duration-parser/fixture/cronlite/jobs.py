"""Job file loading for cronlite, the scheduler on the print-shop's build box."""
from cronlite.durations import parse_duration


def load_job(lines):
    """Parse `key = value` lines into a job dict. `timeout` and `retry_delay` are durations."""
    job = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key in ("timeout", "retry_delay"):
            job[key] = parse_duration(value)
        else:
            job[key] = value
    return job
