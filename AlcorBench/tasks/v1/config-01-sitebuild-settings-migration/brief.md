We need `migrate_settings.py` in the project root so older sites can move from the flat v1 settings layout to schema 2. Compare `examples/legacy-site.json` (v1) with `examples/current-site.json` (the same site after migration); `sitebuild/settings.py` has the schema 2 defaults. Please don't change those three files.

Interface: `python3 migrate_settings.py FILE [FILE ...]`. Each file is handled independently and rewritten in place.

Mapping from v1 keys:
- `base_url` -> `site.base_url`
- `output_dir` -> `build.output`
- `minify` -> `build.minify.enabled`
- `minify_exclude` -> `build.minify.exclude`
- `dev_host` -> `serve.host`
- `dev_port` -> `serve.port`, always an integer (v1 files have it as a number or a numeric string)
- `plugins` -> `plugins`

`minify_exclude` and `plugins` are either a comma-separated string or a list of strings; the result is always a list with items trimmed and empty items dropped. A v1 key that is missing gets the value from `DEFAULTS` in `sitebuild/settings.py`, so a migrated file always has all of `schema` (= `2`), `site`, `build`, `serve` and `plugins` filled in. Any other v1 key that is not in the list above is kept, unchanged, inside a top-level `"legacy"` object; leave `"legacy"` out when there are no such keys.

Per file:
- v1 (no `schema` key): rewrite as JSON (any formatting) and print `migrated FILE` to stdout.
- `"schema": 2`: already migrated. Leave the file exactly as it is, byte for byte, and print `up to date FILE`. Running the script twice on the same file must therefore be safe.
- Any other `schema` value: print `error: FILE: unsupported schema VALUE` to stderr and leave the file alone.
- Not valid JSON, not a JSON object, or unreadable: print `error: FILE: not a settings file` to stderr and leave it alone.

FILE is printed exactly as given on the command line. Exit status is 0 when every file was migrated or up to date, 1 if any file had an error (the other files are still processed).

Done means legacy sites can be migrated with this script and the result loads with `load_settings`.
