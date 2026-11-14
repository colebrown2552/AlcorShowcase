"""Turn the booking system's appointment export into the billing upload file."""
import csv
import sys

OUTPUT_COLUMNS = ["appointment_id", "patient", "date", "minutes", "fee"]


def convert_row(row):
    return {
        "appointment_id": row["appt_id"],
        "patient": row["patient_ref"],
        "date": row["appt_date"],
        "minutes": row["length"],
        "fee": row["fee_gbp"],
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
