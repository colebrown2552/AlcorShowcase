# syncplan

Prints what a one-way sync from SRC to DST would do, without doing it.

    python3 -m syncplan SRC DST [--delete]

Output is one `ACTION PATH` line per file (`copy`, `update`, `delete`), sorted by
path, or `nothing to do`. Layers: `cli.py` (arguments, output) -> `planner.py`
(compares two trees) -> `scanner.py` (walks one tree).
