"""Command line: python3 -m syncplan SRC DST [--delete]"""
import argparse
import os
import sys

from .planner import plan


def main(argv=None):
    parser = argparse.ArgumentParser(prog="syncplan", description="Show what a sync would do.")
    parser.add_argument("src")
    parser.add_argument("dst")
    parser.add_argument("--delete", action="store_true", help="also remove files missing from SRC")
    args = parser.parse_args(argv)
    for root in (args.src, args.dst):
        if not os.path.isdir(root):
            print("syncplan: not a directory: %s" % root, file=sys.stderr)
            return 2
    actions = plan(args.src, args.dst, delete=args.delete)
    if not actions:
        print("nothing to do")
    for action, path in actions:
        print("%s %s" % (action, path))
    return 0
