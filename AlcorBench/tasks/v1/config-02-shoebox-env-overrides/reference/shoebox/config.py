"""Settings for the shoebox photo backup agent."""
import configparser
import os

SECTION = "shoebox"
ENV_PREFIX = "SHOEBOX_"

# key -> (kind, default)
SCHEMA = {
    "source_dir": ("str", "~/Pictures"),
    "target_url": ("str", ""),
    "interval_minutes": ("int", 60),
    "compress": ("bool", True),
    "max_upload_mbps": ("float", 0.0),
    "exclude": ("list", []),
}

KIND_NAMES = {"int": "integer", "float": "number", "bool": "boolean"}
TRUE_WORDS = {"true", "yes", "on", "1"}
FALSE_WORDS = {"false", "no", "off", "0"}


class ConfigError(Exception):
    pass


def _convert(kind, text):
    if kind == "int":
        return int(text)
    if kind == "float":
        return float(text)
    if kind == "bool":
        word = text.strip().lower()
        if word in TRUE_WORDS:
            return True
        if word in FALSE_WORDS:
            return False
        raise ValueError(text)
    if kind == "list":
        return [item.strip() for item in text.split(",") if item.strip()]
    return text


def load_config(path=None, environ=None):
    """Return the effective settings: defaults, then the INI file, then SHOEBOX_* variables."""
    if environ is None:
        environ = os.environ
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
    for key, (kind, _default) in SCHEMA.items():
        name = ENV_PREFIX + key.upper()
        text = environ.get(name)
        if text is None or text == "":
            continue
        try:
            config[key] = _convert(kind, text)
        except ValueError:
            raise ConfigError("%s: expected %s, got %r" % (name, KIND_NAMES[kind], text))
    return config
