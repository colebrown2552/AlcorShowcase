"""Validation of the relay configuration (see docs/config-schema.md)."""

MEDIA = ("label-2x1", "label-4x6", "letter")
TOP_KEYS = ("queue_name", "printers", "retry", "default_printer")
PRINTER_KEYS = ("name", "host", "port", "media")
RETRY_KEYS = ("attempts", "backoff_s")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _non_empty_str(value):
    return isinstance(value, str) and value != ""


def _check_printer(path, printer, seen, errors):
    if not isinstance(printer, dict):
        errors.append("%s: must be an object" % path)
        return
    for key in ("name", "host", "media"):
        if key not in printer:
            errors.append("%s.%s: required" % (path, key))
    if "name" in printer:
        name = printer["name"]
        if not _non_empty_str(name):
            errors.append("%s.name: must be a non-empty string" % path)
        elif name in seen:
            errors.append("%s.name: duplicate name '%s'" % (path, name))
        if isinstance(name, str):
            seen.add(name)
    if "host" in printer and not _non_empty_str(printer["host"]):
        errors.append("%s.host: must be a non-empty string" % path)
    if "port" in printer:
        port = printer["port"]
        if not (_is_int(port) and 1 <= port <= 65535):
            errors.append("%s.port: must be an integer between 1 and 65535" % path)
    if "media" in printer and printer["media"] not in MEDIA:
        errors.append("%s.media: must be one of %s" % (path, ", ".join(MEDIA)))
    for key in printer:
        if key not in PRINTER_KEYS:
            errors.append("%s.%s: unknown key" % (path, key))


def validate(config):
    """Return a list of error messages for `config` (a parsed JSON value).

    An empty list means the configuration is valid.
    """
    if not isinstance(config, dict):
        return ["config: must be an object"]
    errors = []
    if "queue_name" not in config:
        errors.append("queue_name: required")
    elif not _non_empty_str(config["queue_name"]):
        errors.append("queue_name: must be a non-empty string")

    names = None
    if "printers" not in config:
        errors.append("printers: required")
    elif not isinstance(config["printers"], list) or not config["printers"]:
        errors.append("printers: must be a non-empty list")
    else:
        names = set()
        for index, printer in enumerate(config["printers"]):
            _check_printer("printers[%d]" % index, printer, names, errors)

    if "retry" in config:
        retry = config["retry"]
        if not isinstance(retry, dict):
            errors.append("retry: must be an object")
        else:
            if "attempts" in retry and not (_is_int(retry["attempts"]) and 0 <= retry["attempts"] <= 10):
                errors.append("retry.attempts: must be an integer between 0 and 10")
            if "backoff_s" in retry and not (_is_number(retry["backoff_s"]) and retry["backoff_s"] >= 0):
                errors.append("retry.backoff_s: must be a number >= 0")
            for key in retry:
                if key not in RETRY_KEYS:
                    errors.append("retry.%s: unknown key" % key)

    if "default_printer" in config:
        default = config["default_printer"]
        if not isinstance(default, str):
            errors.append("default_printer: must be a string")
        elif names is not None and default not in names:
            errors.append("default_printer: unknown printer '%s'" % default)

    for key in config:
        if key not in TOP_KEYS:
            errors.append("%s: unknown key" % key)
    return errors
