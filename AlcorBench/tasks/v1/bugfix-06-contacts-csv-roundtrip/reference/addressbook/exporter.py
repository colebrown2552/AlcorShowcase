"""Write contacts to a CSV file that spreadsheets can open."""
import csv

from addressbook.models import FIELD_NAMES


def export_contacts(contacts, path):
    """Write ``contacts`` to ``path`` with a header row. Returns the count."""
    count = 0
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(FIELD_NAMES)
        for contact in contacts:
            writer.writerow([str(getattr(contact, name)) for name in FIELD_NAMES])
            count += 1
    return count
