"""Parse lines of the mirror's access log.

Each line is: TIMESTAMP METHOD PATH STATUS BYTES SECONDS, for example

    2026-03-14T09:02:17Z GET /pkgs/tarn-1.2.0.tar.gz 200 18234 0.041

TIMESTAMP is UTC. BYTES is `-` when nothing was sent (cache revalidation).
"""
from collections import namedtuple
from datetime import datetime, timezone

Request = namedtuple("Request", "ts method path status size seconds")


def parse_request(line):
    """Return a Request, or None if the line is malformed."""
    parts = line.split()
    if len(parts) != 6:
        return None
    ts_text, method, path, status, size, seconds = parts
    try:
        ts = datetime.strptime(ts_text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return Request(ts, method, path, int(status), int(size), float(seconds))
    except ValueError:
        return None
