Job files for cronlite can only use single-unit durations (`timeout = 90s`), and a typo like `timeout = 1h30` silently turns into something odd or crashes with an unhelpful message. Please rewrite `parse_duration` in `cronlite/durations.py` so it accepts compound durations and rejects everything else clearly.

`parse_duration(text)` returns the duration as an `int` number of seconds.

Accepted forms (surrounding whitespace is ignored):
- A bare non-negative whole number is seconds: `"45"` -> 45.
- One or more groups of `<digits><unit>`, with units `d` (days), `h` (hours), `m` (minutes), `s` (seconds): `"90s"`, `"1h30m"`, `"2d"`, `"1d12h"`, `"0s"`.
  - Units are lower-case, each unit appears at most once, and groups go from largest to smallest unit (`d`, `h`, `m`, `s`); units may be skipped (`"1d30s"`).
  - Groups may be separated by spaces or tabs (`"1h 30m"`), but there is no space between a number and its unit.
  - Numbers are not limited to the unit's range: `"90m"` -> 5400.

Everything else raises `ValueError` with the message `invalid duration: ` followed by the original argument as Python's `repr()` shows it, e.g. `invalid duration: '1h30'`. That includes empty or blank strings, unknown or upper-case units, repeated or out-of-order units, a unit with no number, signs, and decimals (`"1.5h"`).

`tests/test_durations.py` has a few of the cases (`python3 -m unittest`); please leave it as it is. Done means every job file duration in the forms above parses to the right number of seconds and malformed ones fail with that message.
