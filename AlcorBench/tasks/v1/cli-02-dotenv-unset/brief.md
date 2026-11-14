Deploy scripts keep `sed`-ing keys out of `.env` files and mangling comments. `envtool.py` already has `get`, `set` and `list`; please add an `unset` subcommand that follows the same conventions (`--file` is the global option before the subcommand, default `./.env`).

**Usage:** `envtool.py [--file PATH] unset [--dry-run] KEY [KEY ...]`. At least one KEY is required; `unset` with no keys is a usage error (argparse's usual exit status 2).

Behaviour:

- Removes every line that defines any of the given keys, using the same idea of "defines" as the rest of the tool (`key_of`): `KEY=...`, `export KEY=...`, spaces around the key allowed. Only exact key matches: unsetting `DB` must not touch `DB_HOST`.
- Every other line (comments, blank lines, other keys, junk) is kept unchanged and in order. Lines are written back the way `write_lines` writes them.
- Nothing is printed to stdout (without `--dry-run`).
- For each given key that has no definition in the file, print `envtool: no such key: KEY` to stderr (one line per missing key, in argument order). The keys that do exist are still removed, and the exit status is 1. If every key was found, the exit status is 0.
- If any given key is not a valid key name, print `envtool: invalid key: KEY` to stderr (like `set` does), change nothing, and exit with status 2.
- A missing file is treated as an empty file (so every key is "no such key") and must not be created.
- `--dry-run`: don't modify the file; print the content the file *would* have to stdout instead, in the same format `write_lines` uses (one line per line, each ending in `\n`). Stderr messages and exit status are the same as for a real run.

Example: with `.env` containing `# db\nDB=x\nDB_HOST=y\n`, `envtool.py unset DB` leaves `# db\nDB_HOST=y\n` and exits 0; `envtool.py unset DB NOPE` does the same but also prints `envtool: no such key: NOPE` to stderr and exits 1.

`tests/test_envtool.py` must keep passing; don't change it.
