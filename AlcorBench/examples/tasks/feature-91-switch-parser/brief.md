`parse_flag` in `settings/flags.py` is still a stub, so every on/off setting read
through `flag_from_env` crashes. Please implement it.

It should accept `true`/`false`, `yes`/`no`, `on`/`off` and `1`/`0`, in any letter case
and with surrounding whitespace ignored, and return a real `bool`. Any other value
(including an empty string) must raise `ValueError` with the offending value in the
message, so a typo in a setting is reported rather than silently treated as off.

`flag_from_env` already handles missing and blank values; keep its behaviour. The tests
in `tests/` run with `python3 -m unittest` and should stay unchanged.
