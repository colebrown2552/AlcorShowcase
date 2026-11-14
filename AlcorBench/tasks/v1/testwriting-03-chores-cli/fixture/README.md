# chores

A tiny to-do list for household chores, stored in a JSON file.

The data file is `~/.chores.json` unless `--file PATH` is given before the
command or the `CHORES_FILE` environment variable is set (`--file` wins).
A missing file means an empty list.

## Commands

    python3 -m chores [--file PATH] add TITLE [--due YYYY-MM-DD]
    python3 -m chores [--file PATH] done ID
    python3 -m chores [--file PATH] list [--all]

* `add` prints `added #ID: TITLE`. Ids start at 1 and each new chore gets the
  next unused number. A bad `--due` date is a usage error.
* `done ID` prints `done #ID`. If the chore is already done it prints
  `already done #ID`; both exit 0. An unknown id prints
  `no such chore: ID` to stderr and exits with status 3.
* `list` prints one line per open chore, `#ID [ ] TITLE`, followed by
  ` (due YYYY-MM-DD)` when it has a due date. Chores with a due date come
  first, earliest date first; chores without one follow; ties keep id order.
  `--all` also shows finished chores, marked `[x]`, in the same ordering.
  With nothing to show it prints `nothing to do`.

Usage errors (unknown command, missing argument, bad date) exit with status 2.
