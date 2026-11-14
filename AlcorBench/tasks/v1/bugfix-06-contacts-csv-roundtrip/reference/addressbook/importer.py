"""Read contacts back from a CSV export (ours, or an older one)."""
import csv

from addressbook.models import FIELD_NAMES, Contact


def import_contacts(path):
    """Return the contacts in ``path``.

    The first row names the columns; they may come in any order and older
    exports lack some of them (missing fields become ""). Unknown columns are
    ignored and blank lines are skipped.
    """
    with open(path, encoding="utf-8", newline="") as fh:
        rows = list(csv.reader(fh))
    if not rows:
        return []
    header = [h.strip() for h in rows[0]]
    contacts = []
    for values in rows[1:]:
        if not any(v.strip() for v in values):
            continue
        row = dict(zip(header, values))
        contacts.append(Contact(**{name: row.get(name, "") for name in FIELD_NAMES}))
    return contacts
