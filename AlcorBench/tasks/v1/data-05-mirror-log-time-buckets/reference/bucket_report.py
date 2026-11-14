"""Summarise the mirror access log per time interval (CSV on stdout)."""
import argparse
import csv
import re
import sys
from datetime import datetime, timezone

from mirrorlog.parse import parse_request


def bucket_seconds(text):
    match = re.fullmatch(r"([1-9][0-9]*)([mh])", text)
    if not match:
        return None
    return int(match.group(1)) * (60 if match.group(2) == "m" else 3600)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logfile")
    parser.add_argument("--bucket", default="5m")
    args = parser.parse_args(argv)
    size = bucket_seconds(args.bucket)
    if size is None:
        print("invalid bucket size: %r" % args.bucket, file=sys.stderr)
        return 2

    buckets = {}
    skipped = 0
    with open(args.logfile, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            req = parse_request(line)
            if req is None:
                skipped += 1
                continue
            start = int(req.ts.timestamp()) // size * size
            stats = buckets.setdefault(start, [0, 0, 0, 0])
            stats[0] += 1
            stats[1] += req.status >= 500
            stats[2] += req.size
            stats[3] = max(stats[3], round(req.seconds * 1000))

    out = csv.writer(sys.stdout, lineterminator="\n")
    out.writerow(["bucket_start", "requests", "errors", "bytes", "max_ms"])
    if buckets:
        for start in range(min(buckets), max(buckets) + size, size):
            stamp = datetime.fromtimestamp(start, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            out.writerow([stamp] + buckets.get(start, [0, 0, 0, 0]))
    if skipped:
        print("skipped %d malformed lines" % skipped, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
