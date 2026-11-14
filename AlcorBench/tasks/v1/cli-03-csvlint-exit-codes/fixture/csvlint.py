#!/usr/bin/env python3
"""Lint CSV exports before they are loaded into the warehouse."""
import argparse
import csv
import sys


def lint_file(path, required):
    """Return (row_count, problems) where problems are (line_number, message) pairs."""
    problems = []
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header is None:
            return 0, [(1, "empty file: no header")]
        for column in required:
            if column not in header:
                problems.append((1, "missing required column: %s" % column))
        positions = [(c, header.index(c)) for c in required if c in header]
        count = 0
        for row in reader:
            if not row:
                continue
            count += 1
            line = reader.line_num
            if len(row) != len(header):
                problems.append((line, "expected %d fields, got %d" % (len(header), len(row))))
                continue
            for column, index in positions:
                if not row[index].strip():
                    problems.append((line, "empty value in required column %s" % column))
    return count, problems


def main(argv=None):
    parser = argparse.ArgumentParser(prog="csvlint", description=__doc__)
    parser.add_argument("files", nargs="+", metavar="FILE")
    parser.add_argument("--require", action="append", default=[], metavar="COLUMN",
                        help="column that must exist and be non-empty (repeatable)")
    parser.add_argument("-q", "--quiet", action="store_true", help="no per-file summary")
    args = parser.parse_args(argv)

    for path in args.files:
        count, problems = lint_file(path, args.require)
        if args.quiet:
            continue
        for line, message in problems:
            print("%s:%d: %s" % (path, line, message))
        print("%s: %d rows, %d problems" % (path, count, len(problems)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
