The kiln controllers write event lines like

```
ts=2026-08-03T09:40:12Z level=warn kiln=k2 msg="thermocouple \"B\" drifting" delta_c=-14.5
```

and `parse_line` in `eventlog/kv.py` just splits on whitespace, so any quoted value with a space or an escape comes out wrong (see `samples/kiln.log`). Please rewrite it as a proper parser for this format.

`parse_line(line)` returns a `dict` mapping each key to its value, both `str`. A trailing newline (`\n` or `\r\n`) is ignored.

Syntax:
- Fields are separated by one or more spaces or tabs; leading and trailing spaces/tabs are allowed. A blank line gives `{}`.
- A field is `key=value` with nothing between the key, the `=` and the value.
- A key starts with a letter or `_`, followed by letters, digits, `_`, `.` or `-`.
- A bare value runs up to the next space/tab or the end of the line. It may be empty (`note=`) and may contain `=` (`query=a=b`), but not `"`.
- A quoted value is enclosed in double quotes and may contain spaces, tabs and `=`. Inside it, `\"` is a quote, `\\` a backslash, `\n` a newline and `\t` a tab; any other backslash sequence is an error. `""` is an empty value. The closing quote must be followed by a space/tab or the end of the line.
- If a key appears more than once, the last value wins.

Anything that breaks these rules raises `KVSyntaxError` (from `eventlog/errors.py`; don't change that file): a field without `=`, an invalid key, a space around `=`, an unterminated quote, a bad escape, a `"` inside a bare value, or text right after a closing quote. The message text is up to you.

For the second sample line, `msg` is `thermocouple "B" drifting` and `delta_c` is `-14.5`. Done means any line in this format parses to the right fields and broken lines raise `KVSyntaxError`.
