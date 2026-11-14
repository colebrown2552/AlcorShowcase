"""Reading on/off switches from environment-style strings."""


def parse_flag(text):
    """Turn a switch value such as "yes" or "0" into a bool."""
    words = {"true": True, "yes": True, "on": True, "1": True,
             "false": False, "no": False, "off": False, "0": False}
    key = text.strip().lower()
    if key not in words:
        raise ValueError(f"not an on/off value: {text!r}")
    return words[key]


def flag_from_env(env, name, default=False):
    """Look up name in env and parse it; a missing or blank value means default."""
    value = env.get(name, "")
    if not value.strip():
        return default
    return parse_flag(value)
