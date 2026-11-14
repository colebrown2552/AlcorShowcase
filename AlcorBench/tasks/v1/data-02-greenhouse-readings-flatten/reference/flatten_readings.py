"""Convert a JSON Lines file of sensor readings into a flat CSV table."""
import csv
import json
import sys

LEADING = ["device", "ts"]


def _text(value):
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def flatten(record, prefix=""):
    """Return a flat {column: text} dict for one reading."""
    flat = {}
    for key, value in record.items():
        name = prefix + key
        if isinstance(value, dict):
            flat.update(flatten(value, name + "."))
        elif isinstance(value, list):
            flat[name] = "|".join(_text(item) for item in value)
        else:
            flat[name] = _text(value)
    return flat


def main(argv):
    if len(argv) != 3:
        print("usage: flatten_readings.py READINGS_JSONL OUTPUT_CSV", file=sys.stderr)
        return 2
    rows = []
    with open(argv[1], encoding="utf-8") as src:
        for number, line in enumerate(src, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except ValueError:
                print("line %d: invalid JSON" % number, file=sys.stderr)
                return 1
            rows.append(flatten(record))
    others = sorted({key for row in rows for key in row} - set(LEADING))
    with open(argv[2], "w", newline="", encoding="utf-8") as dst:
        writer = csv.DictWriter(dst, fieldnames=LEADING + others, restval="")
        writer.writeheader()
        writer.writerows(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
