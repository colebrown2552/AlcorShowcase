"""Check events against schema/events.json."""
import json
import os

_SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema", "events.json")
_TYPES = {"string": str, "integer": int}


class SchemaError(ValueError):
    pass


def load_schema():
    with open(_SCHEMA_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def validate(event):
    """Raise SchemaError unless `event` matches the schema exactly."""
    schema = load_schema()
    if not isinstance(event, dict) or set(event) != {"event", "version", "payload"}:
        raise SchemaError("an event has exactly the keys event, version, payload")
    if event["version"] != schema["version"]:
        raise SchemaError("unsupported version: %r" % (event["version"],))
    spec = schema["events"].get(event["event"])
    if spec is None:
        raise SchemaError("unknown event: %r" % (event["event"],))
    payload = event["payload"]
    if set(payload) != set(spec["payload"]):
        raise SchemaError("%s payload needs fields %s" % (event["event"], sorted(spec["payload"])))
    for field, type_name in spec["payload"].items():
        value = payload[field]
        if not isinstance(value, _TYPES[type_name]) or isinstance(value, bool):
            raise SchemaError("%s.%s must be %s" % (event["event"], field, type_name))
