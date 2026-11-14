"""Parsing of the key=value event lines written by the kiln controllers."""
import re

from eventlog.errors import KVSyntaxError

_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]*")
_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t"}
_SPACE = " \t"


def parse_line(line):
    """Return the fields of one event line as a dict of str -> str."""
    line = line.rstrip("\r\n")
    fields = {}
    pos, end = 0, len(line)
    while True:
        while pos < end and line[pos] in _SPACE:
            pos += 1
        if pos >= end:
            return fields
        match = _KEY.match(line, pos)
        if not match:
            raise KVSyntaxError("invalid key at column %d" % (pos + 1))
        key, pos = match.group(), match.end()
        if pos >= end or line[pos] != "=":
            raise KVSyntaxError("missing '=' after %r" % key)
        pos += 1
        if pos < end and line[pos] == '"':
            pos += 1
            chars = []
            while True:
                if pos >= end:
                    raise KVSyntaxError("unterminated quote in %r" % key)
                ch = line[pos]
                if ch == '"':
                    pos += 1
                    break
                if ch == "\\":
                    if pos + 1 >= end or line[pos + 1] not in _ESCAPES:
                        raise KVSyntaxError("bad escape in %r" % key)
                    chars.append(_ESCAPES[line[pos + 1]])
                    pos += 2
                    continue
                chars.append(ch)
                pos += 1
            if pos < end and line[pos] not in _SPACE:
                raise KVSyntaxError("text after closing quote in %r" % key)
            value = "".join(chars)
        else:
            start = pos
            while pos < end and line[pos] not in _SPACE:
                if line[pos] == '"':
                    raise KVSyntaxError("stray quote in %r" % key)
                pos += 1
            value = line[start:pos]
        fields[key] = value
