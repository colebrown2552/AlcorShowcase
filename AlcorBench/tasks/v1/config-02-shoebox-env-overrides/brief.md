On the NAS we run the shoebox backup agent in a container, and we want to configure it with environment variables instead of mounting an INI file. Please add environment overrides to `load_config` in `shoebox/config.py`.

New signature: `load_config(path=None, environ=None)`. `environ` is a mapping of variable names to strings; when it is `None`, use `os.environ`. Existing callers that pass only `path` must keep working.

Behaviour:
- Precedence, lowest to highest: the defaults in `SCHEMA`, the INI file (if `path` is given), then environment variables.
- Every key in `SCHEMA` can be overridden by `SHOEBOX_` + the key in upper case, e.g. `SHOEBOX_INTERVAL_MINUTES`. Other `SHOEBOX_*` variables are ignored.
- A variable set to the empty string is treated as not set.
- Values are parsed according to the key's kind in `SCHEMA`:
  - `int`: a whole number, surrounding whitespace allowed (`" 15 "` -> 15, `"1.5"` is invalid).
  - `float`: any number Python's `float()` accepts.
  - `bool`: case-insensitive, surrounding whitespace allowed: `true`, `yes`, `on`, `1` are true; `false`, `no`, `off`, `0` are false.
  - `list`: comma-separated, items trimmed, empty items dropped (`"*.tmp, ,raw/"` -> `["*.tmp", "raw/"]`).
  - `str`: used as is.
- The same `bool` words must also be accepted in the INI file (today it only takes `true`/`false`).
- An environment value that cannot be parsed raises `ConfigError` with exactly this message: `<VARIABLE>: expected <kind>, got '<value>'`, where kind is `integer`, `number` or `boolean`, and the value is shown as Python's `repr()` would show it. Example: `SHOEBOX_INTERVAL_MINUTES: expected integer, got 'ten'`.

`python3 -m shoebox shoebox.ini` prints the effective settings, so `SHOEBOX_COMPRESS=yes python3 -m shoebox shoebox.ini` should now show `"compress": true`. Done means overrides work for every key and kind, with the errors above.
