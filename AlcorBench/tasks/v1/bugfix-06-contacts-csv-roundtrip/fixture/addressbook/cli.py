"""python3 -m addressbook.cli export|import FILE (store is a JSON file)."""
import argparse
import json
import sys
from dataclasses import asdict

from addressbook.exporter import export_contacts
from addressbook.importer import import_contacts
from addressbook.models import Contact


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["export", "import"])
    parser.add_argument("csv_path")
    parser.add_argument("--store", default="contacts.json")
    args = parser.parse_args(argv)
    if args.command == "export":
        with open(args.store, encoding="utf-8") as fh:
            contacts = [Contact(**row) for row in json.load(fh)]
        n = export_contacts(contacts, args.csv_path)
        print(f"exported {n} contacts")
    else:
        contacts = import_contacts(args.csv_path)
        with open(args.store, "w", encoding="utf-8") as fh:
            json.dump([asdict(c) for c in contacts], fh, indent=2, ensure_ascii=False)
        print(f"imported {len(contacts)} contacts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
