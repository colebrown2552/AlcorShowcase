We want to run `csvlint.py` as a CI gate before the warehouse load, but right now it can't be used that way: it always exits 0, problems and summaries are mixed together on stdout, `-q` hides the problems along with the summary, and a missing file kills the run with a traceback. Please fix the stream and exit-status handling in `csvlint.py`. The lint rules themselves (`lint_file` and its messages) are right and should not change.

Required behaviour:

- **Problems** go to **stderr**, one per line, as `PATH:LINE: MESSAGE` (the existing format and messages, `PATH` exactly as given on the command line). They are always printed, with or without `-q`.
- **Summaries** go to **stdout**: one line `PATH: N rows, M problems` per file that could be read, in command-line order. `-q`/`--quiet` suppresses only these summary lines.
- Nothing else is printed to stdout, and stderr carries only the problem lines plus lines starting with `csvlint: ` (such as the cannot-read message below).
- **Unreadable files** (missing, a directory, no permission, or not valid UTF-8): print `csvlint: cannot read PATH: REASON` to stderr (any short reason), print no summary for that file, and carry on with the remaining files. No traceback.
- **Exit status:** `2` if any file could not be read; otherwise `1` if any problem was found in any file; otherwise `0`. Argument errors (e.g. no files) keep argparse's usual status 2.

Example: `python3 csvlint.py samples/orders.csv --require customer` prints `samples/orders.csv: 3 rows, 2 problems` on stdout, the two `samples/orders.csv:3: ...` / `samples/orders.csv:4: ...` lines on stderr, and exits 1.

Leave `samples/orders.csv` as it is. Standard library only.
