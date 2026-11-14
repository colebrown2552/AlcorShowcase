"""Duration strings used in job files, e.g. `timeout = 90s`."""


def parse_duration(text):
    """Return the number of seconds in a duration string."""
    text = text.strip()
    if text.endswith("s"):
        return int(text[:-1])
    if text.endswith("m"):
        return int(text[:-1]) * 60
    if text.endswith("h"):
        return int(text[:-1]) * 3600
    return int(text)
