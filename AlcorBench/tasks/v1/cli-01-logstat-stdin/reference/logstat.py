#!/usr/bin/env python3
"""Count log lines per level."""
import argparse
import sys
from collections import Counter

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


def count_levels(lines):
    counts = Counter()
    for line in lines:
        parts = line.split(None, 2)
        if len(parts) >= 2 and parts[1] in LEVELS:
            counts[parts[1]] += 1
    return counts


def report(counts, level=None):
    if level:
        return ["%s %d" % (level, counts[level])]
    return ["%s %d" % (name, counts[name]) for name in LEVELS if counts[name]]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="logstat", description="Count log lines per level.")
    parser.add_argument("file", nargs="?", default="-",
                        help="log file to read (default or '-': standard input)")
    parser.add_argument("--level", choices=LEVELS, help="only print the count for this level")
    args = parser.parse_args(argv)
    if args.file == "-":
        counts = count_levels(sys.stdin)
    else:
        try:
            with open(args.file, encoding="utf-8") as handle:
                counts = count_levels(handle)
        except OSError as exc:
            print("logstat: cannot read %s: %s" % (args.file, exc.strerror), file=sys.stderr)
            return 2
    for line in report(counts, args.level):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
