"""Turn the booking system's appointment export into the billing upload file."""
import csv
import sys
from decimal import Decimal

OUTPUT_COLUMNS = ["visit_id", "visit_date", "patient_ref", "duration_min", "fee_pence"]


def to_iso_date(text):
    day, month, year = (int(part) for part in text.strip().split("/"))
    return "%04d-%02d-%02d" % (year, month, day)


def to_pence(text):
    text = text.strip().lstrip("£").strip()
    if not text:
        return 0
    return int(Decimal(text) * 100)


def convert_row(row):
    return {
        "visit_id": row["appt_id"].strip(),
        "visit_date": to_iso_date(row["appt_date"]),
        "patient_ref": row["patient_ref"].strip().upper(),
        "duration_min": int(float(row["length"].strip())),
        "fee_pence": to_pence(row["fee_gbp"]),
    }


def main(argv):
    if len(argv) != 3:
        print("usage: export_for_billing.py APPOINTMENTS_CSV OUTPUT_CSV", file=sys.stderr)
        return 2
    with open(argv[1], newline="", encoding="utf-8") as src:
        rows = [convert_row(r) for r in csv.DictReader(src)]
    with open(argv[2], "w", newline="", encoding="utf-8") as dst:
        writer = csv.DictWriter(dst, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
