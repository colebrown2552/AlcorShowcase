"""Reading on/off switches from environment-style strings."""


def parse_flag(text):
    """Turn a switch value such as "yes" or "0" into a bool."""
    raise NotImplementedError("parse_flag")


def flag_from_env(env, name, default=False):
    """Look up name in env and parse it; a missing or blank value means default."""
    value = env.get(name, "")
    if not value.strip():
        return default
    return parse_flag(value)
