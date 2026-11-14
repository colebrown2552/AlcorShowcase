`syncplan` keeps proposing to copy build output and editor junk, and with `--delete` it wants to remove files on the target that we deliberately keep there. Please add ignore patterns, available at every layer: the command line, `plan()` and `scan()`.

**Matching rule** (implement it once and reuse it): a file is ignored if a pattern matches, using `fnmatch.fnmatchcase` (case-sensitive), either its whole relative path (with `/` separators, as `scan` already reports it) or any single component of that path. So `*.tmp` ignores `x.tmp` and `a/b/x.tmp`; `build` ignores everything under any directory called `build` (`build/out.o`, `lib/build/x.c`) but not `build.txt`; `docs/draft.md` ignores exactly that file.

**Required changes:**

- `syncplan/scanner.py`: `scan(root, ignore=())` leaves ignored files out of its result.
- `syncplan/planner.py`: `plan(src_root, dst_root, delete=False, ignore=())` applies the patterns to **both** trees, so an ignored path is never copied, updated, or deleted, even when it only exists in the destination.
- `syncplan/cli.py`: a repeatable `--ignore PATTERN` option (`--ignore '*.tmp' --ignore build`) passed down to `plan`.
- `ignore` is a list or tuple of pattern strings. With no patterns, everything behaves exactly as it does now, including the output format and exit codes.

Example: `python3 -m syncplan src dst --delete --ignore '*.log'` no longer lists `copy app.log` and no longer proposes `delete server.log` for a log file that only exists in `dst`.

Update the usage line in `README.md` so it shows the new `--ignore` option. `tests/test_plan.py` must keep passing; don't change it.
