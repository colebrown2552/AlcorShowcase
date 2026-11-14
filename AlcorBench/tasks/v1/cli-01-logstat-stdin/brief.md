`logstat.py` only works on a file path, so in the nightly job we write `journalctl` output to a temp file first just to count it. Please make it read standard input as well, so `journalctl ... | python3 logstat.py --level ERROR` works.

Required behaviour:

- The positional `file` argument becomes optional. When it is omitted, or given as `-`, the log is read from standard input.
- Everything else stays the same for both sources: the same counting rules, the same output (`LEVEL COUNT` lines on stdout in the order DEBUG, INFO, WARNING, ERROR, CRITICAL, levels with zero lines left out; with `--level X` exactly one line `X COUNT`, even when the count is 0), and exit status 0.
- Empty input is fine: no output (or `X 0` with `--level X`), exit status 0.
- Reading a named file that can't be opened still prints `logstat: cannot read ...` to stderr, nothing to stdout, and exits with status 2.
- The `--help` text for the argument says that it reads from standard input (use the word `stdin` or `standard input`).

The tests in `tests/test_logstat.py` must keep passing; don't change them. Standard library only.
