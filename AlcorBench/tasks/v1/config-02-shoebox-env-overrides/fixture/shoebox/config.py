"""Settings for the shoebox photo backup agent."""
import configparser

SECTION = "shoebox"

# key -> (kind, default)
SCHEMA = {
    "source_dir": ("str", "~/Pictures"),
    "target_url": ("str", ""),
    "interval_minutes": ("int", 60),
    "compress": ("bool", True),
    "max_upload_mbps": ("float", 0.0),
    "exclude": ("list", []),
}


class ConfigError(Exception):
    pass


def _convert(kind, text):
    if kind == "int":
        return int(text)
    if kind == "float":
        return float(text)
    if kind == "bool":
        if text.lower() == "true":
            return True
        if text.lower() == "false":
            return False
        raise ValueError(text)
    if kind == "list":
        return [item.strip() for item in text.split(",") if item.strip()]
    return text


def load_config(path=None):
    """Return the effective settings as a dict: defaults, then the INI file."""
    config = {key: default for key, (kind, default) in SCHEMA.items()}
    if path is not None:
        parser = configparser.ConfigParser()
        parser.read(path, encoding="utf-8")
        if parser.has_section(SECTION):
            for key, text in parser.items(SECTION):
                if key not in SCHEMA:
                    continue
                kind = SCHEMA[key][0]
                try:
                    config[key] = _convert(kind, text)
                except ValueError:
                    raise ConfigError("%s: bad value for %s: %r" % (path, key, text))
    return config
