#!/usr/bin/env python3
"""Edit .env files from scripts without disturbing comments or layout.

A definition is a line `KEY=VALUE` (optionally `export KEY=VALUE`, spaces
allowed around the key). Comments (`#`) and blank lines are kept as they are.
"""
import argparse
import re
import sys

KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def read_lines(path):
    """The file's lines without line endings; a missing file reads as empty."""
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().splitlines()
    except FileNotFoundError:
        return []


def write_lines(path, lines):
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("".join(line + "\n" for line in lines))


def key_of(line):
    """The key a line defines, or None for comments, blanks and junk."""
    text = line.strip()
    if not text or text.startswith("#") or "=" not in text:
        return None
    key = text.split("=", 1)[0].strip()
    if key.startswith("export "):
        key = key[len("export "):].strip()
    return key if KEY_RE.match(key) else None


def value_of(line):
    return line.split("=", 1)[1].strip()


def check_key(key):
    if not KEY_RE.match(key):
        print("envtool: invalid key: %s" % key, file=sys.stderr)
        return False
    return True


def cmd_get(args):
    if not check_key(args.key):
        return 2
    found = None
    for line in read_lines(args.file):
        if key_of(line) == args.key:
            found = value_of(line)  # the last definition wins, like the shell
    if found is None:
        print("envtool: no such key: %s" % args.key, file=sys.stderr)
        return 1
    print(found)
    return 0


def cmd_set(args):
    if not check_key(args.key):
        return 2
    lines = read_lines(args.file)
    new_line = "%s=%s" % (args.key, args.value)
    replaced = False
    for index, line in enumerate(lines):
        if key_of(line) == args.key:
            lines[index] = new_line
            replaced = True
    if not replaced:
        lines.append(new_line)
    write_lines(args.file, lines)
    return 0


def cmd_list(args):
    values = {}
    for line in read_lines(args.file):
        key = key_of(line)
        if key is not None:
            values[key] = value_of(line)
    for key, value in values.items():
        print("%s=%s" % (key, value))
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="envtool", description=__doc__.splitlines()[0])
    parser.add_argument("--file", default=".env", help="the .env file (default: ./.env)")
    sub = parser.add_subparsers(dest="command", required=True)

    get = sub.add_parser("get", help="print the value of KEY")
    get.add_argument("key")
    get.set_defaults(func=cmd_get)

    set_ = sub.add_parser("set", help="set KEY to VALUE")
    set_.add_argument("key")
    set_.add_argument("value")
    set_.set_defaults(func=cmd_set)

    list_ = sub.add_parser("list", help="print every KEY=VALUE")
    list_.set_defaults(func=cmd_list)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
