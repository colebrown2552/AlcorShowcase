"""Print event lines whose fields match all KEY=VALUE filters.

    python3 -m eventlog.grep_events LOGFILE KEY=VALUE [KEY=VALUE ...]
"""
import sys

from eventlog.errors import KVSyntaxError
from eventlog.kv import parse_line


def main(argv):
    if len(argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    wanted = dict(arg.split("=", 1) for arg in argv[2:])
    with open(argv[1], encoding="utf-8") as fh:
        for number, line in enumerate(fh, start=1):
            try:
                fields = parse_line(line)
            except KVSyntaxError as exc:
                print("line %d: %s" % (number, exc), file=sys.stderr)
                continue
            if all(fields.get(k) == v for k, v in wanted.items()):
                print(line, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
