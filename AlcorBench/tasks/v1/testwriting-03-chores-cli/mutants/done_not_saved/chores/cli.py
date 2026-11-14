"""Command-line interface; see README.md."""
import argparse
import sys
from datetime import date

from chores import store

NO_SUCH_CHORE = 3


def _due(text):
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {text}") from None


def build_parser():
    parser = argparse.ArgumentParser(prog="chores")
    parser.add_argument("--file", help="data file (default: $CHORES_FILE or ~/.chores.json)")
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add")
    add.add_argument("title")
    add.add_argument("--due", type=_due)
    done = sub.add_parser("done")
    done.add_argument("id", type=int)
    lst = sub.add_parser("list")
    lst.add_argument("--all", action="store_true")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    path = args.file or store.default_path()
    chores = store.load(path)

    if args.command == "add":
        chore = {"id": store.next_id(chores), "title": args.title, "due": args.due, "done": False}
        chores.append(chore)
        store.save(path, chores)
        print(f"added #{chore['id']}: {chore['title']}")
        return 0

    if args.command == "done":
        for chore in chores:
            if chore["id"] == args.id:
                if chore["done"]:
                    print(f"already done #{args.id}")
                    return 0
                chore["done"] = True
                print(f"done #{args.id}")
                return 0
        print(f"no such chore: {args.id}", file=sys.stderr)
        return NO_SUCH_CHORE

    shown = [c for c in store.ordered(chores) if args.all or not c["done"]]
    if not shown:
        print("nothing to do")
    for chore in shown:
        mark = "x" if chore["done"] else " "
        due = f" (due {chore['due']})" if chore["due"] else ""
        print(f"#{chore['id']} [{mark}] {chore['title']}{due}")
    return 0
