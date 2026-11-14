"""labelrelay: forwards print jobs from the lab's sample tracker to label printers.

    python3 -m labelrelay check CONFIG_JSON
"""
import json
import sys


def check(path):
    with open(path, encoding="utf-8") as fh:
        json.load(fh)
    print("ok")
    return 0


def main(argv):
    if len(argv) != 3 or argv[1] != "check":
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return check(argv[2])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
