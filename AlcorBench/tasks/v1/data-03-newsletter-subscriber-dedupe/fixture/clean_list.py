"""Clean the subscriber export: python3 clean_list.py INPUT_CSV OUTPUT_CSV"""
import csv
import sys

from listtools.dedupe import dedupe

COLUMNS = ["email", "name", "signed_up", "source"]


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    with open(argv[1], newline="", encoding="utf-8") as src:
        rows = list(csv.DictReader(src))
    with open(argv[2], "w", newline="", encoding="utf-8") as dst:
        writer = csv.DictWriter(dst, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(dedupe(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
