Library staff keep tripping over the Options table in `README.md`: it lists flags that no longer exist, misses new ones, and several defaults are wrong. Please bring the table back in line with what the `castgrab` command actually accepts today. The code is the source of truth (`castgrab/cli.py` and `castgrab/options.py`); don't change the code, only the README.

What the table must look like when you're done:
- It stays under the `## Options` heading, as a Markdown table with the three columns `Option | Default | Description`.
- One row for every optional flag that `castgrab --help` would list, except `--help` itself (the positional `feeds_file` is not in the table). Options that are deliberately hidden from the help output are not documented. Options that are no longer accepted are removed.
- The Option column shows the long form of the flag in backticks (`--max-episodes`, not `-n`).
- The Default column shows the default value as argparse holds it, in backticks: numbers and strings as Python's `str()` writes them (`10`, `30.0`, `episodes`), booleans as `true` / `false`, and `-` when the default is `None` or the option has no default value.
- The Description is a short sentence; reuse the help text where there is one.
- Row order is up to you. Keep the rest of the README (Install, Usage, Feeds file) as it is.

Done means someone reading the README sees exactly the options and defaults the tool really has.
