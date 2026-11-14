"""Default options per export format. Callers may override any of them, and only them."""
DEFAULTS = {
    "csv": {"delimiter": ",", "header": True},
    "json": {"indent": 2, "sort_keys": False},
    "markdown": {"align": "left"},
}


def resolve_options(fmt, overrides):
    """Defaults for `fmt` updated with `overrides`; unknown option names are an error."""
    options = dict(DEFAULTS[fmt])
    for name, value in overrides.items():
        if name not in options:
            raise ValueError("format %r has no option %r" % (fmt, name))
        options[name] = value
    return options
