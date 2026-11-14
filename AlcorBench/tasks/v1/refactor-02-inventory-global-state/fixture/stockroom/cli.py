"""python3 -m stockroom.cli --state FILE COMMAND ..."""
import argparse
import json
import os
import sys

from stockroom import inventory, report


def main(argv=None):
    parser = argparse.ArgumentParser(prog="stockroom")
    parser.add_argument("--state", default="stock.json")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("receive", "ship"):
        p = sub.add_parser(name)
        p.add_argument("sku")
        p.add_argument("qty", type=int)
    p = sub.add_parser("level")
    p.add_argument("sku")
    p = sub.add_parser("report")
    p.add_argument("--threshold", type=int, default=5)
    sub.add_parser("history")
    args = parser.parse_args(argv)

    if os.path.exists(args.state):
        with open(args.state, encoding="utf-8") as fh:
            inventory.load_state(json.load(fh))

    try:
        if args.cmd == "receive":
            print(f"{args.sku}: {inventory.receive(args.sku, args.qty)}")
        elif args.cmd == "ship":
            print(f"{args.sku}: {inventory.ship(args.sku, args.qty)}")
        elif args.cmd == "level":
            print(f"{args.sku}: {inventory.level(args.sku)}")
        elif args.cmd == "report":
            print(report.low_stock_report(args.threshold))
        else:
            for op, sku, qty in inventory.history():
                print(f"{op:<8} {sku:<12} {qty:>5}")
    except inventory.InsufficientStock as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    with open(args.state, "w", encoding="utf-8") as fh:
        json.dump(inventory.dump_state(), fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
