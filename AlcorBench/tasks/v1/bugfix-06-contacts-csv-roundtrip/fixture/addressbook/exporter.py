"""Write contacts to a CSV file that spreadsheets can open."""
from addressbook.models import FIELD_NAMES


def export_contacts(contacts, path):
    """Write ``contacts`` to ``path`` with a header row. Returns the count."""
    count = 0
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(",".join(FIELD_NAMES) + "\n")
        for contact in contacts:
            fh.write(",".join(str(getattr(contact, name)) for name in FIELD_NAMES) + "\n")
            count += 1
    return count
