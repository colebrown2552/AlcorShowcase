"""Read contacts back from a CSV export (ours, or an older one)."""
from addressbook.models import FIELD_NAMES, Contact


def import_contacts(path):
    """Return the contacts in ``path``.

    The first row names the columns; they may come in any order and older
    exports lack some of them (missing fields become ""). Unknown columns are
    ignored and blank lines are skipped.
    """
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    if not lines:
        return []
    header = [h.strip() for h in lines[0].split(",")]
    contacts = []
    for line in lines[1:]:
        if not line.strip():
            continue
        values = line.split(",")
        row = dict(zip(header, values))
        contacts.append(Contact(**{name: row.get(name, "") for name in FIELD_NAMES}))
    return contacts
