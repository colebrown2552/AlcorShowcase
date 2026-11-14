"""Print an invoice from a CSV of description,unit_price,quantity rows."""
import argparse
import csv
import sys

from billing.invoice import Invoice


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_file")
    parser.add_argument("--number", default="DRAFT")
    parser.add_argument("--tax-bp", type=int, default=0)
    args = parser.parse_args(argv)
    invoice = Invoice(args.number, args.tax_bp)
    with open(args.csv_file, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            invoice.add_line(row["description"], row["unit_price"], int(row["quantity"]))
    print(invoice.render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
