"""Parsing of the key=value event lines written by the kiln controllers."""
from eventlog.errors import KVSyntaxError


def parse_line(line):
    """Return the fields of one event line as a dict of str -> str."""
    fields = {}
    for token in line.split():
        if "=" not in token:
            raise KVSyntaxError("missing '=' in %r" % token)
        key, value = token.split("=", 1)
        fields[key] = value.strip('"')
    return fields
