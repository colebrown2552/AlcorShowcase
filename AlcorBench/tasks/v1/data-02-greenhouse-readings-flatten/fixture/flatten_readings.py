"""Convert a JSON Lines file of sensor readings into a flat CSV table."""
import csv
import json
import sys


def flatten(record):
    """Return a flat {column: text} dict for one reading."""
    raise NotImplementedError


def main(argv):
    if len(argv) != 3:
        print("usage: flatten_readings.py READINGS_JSONL OUTPUT_CSV", file=sys.stderr)
        return 2
    raise NotImplementedError


if __name__ == "__main__":
    sys.exit(main(sys.argv))
