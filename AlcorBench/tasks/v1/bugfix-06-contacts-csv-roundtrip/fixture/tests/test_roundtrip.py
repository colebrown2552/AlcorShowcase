import os
import tempfile
import unittest

from addressbook.exporter import export_contacts
from addressbook.importer import import_contacts
from addressbook.models import Contact

HERE = os.path.dirname(os.path.abspath(__file__))


class RoundTripTests(unittest.TestCase):
    def test_simple_roundtrip(self):
        people = [
            Contact("Ana Silva", "ana@example.com", "Silva Design", "555-0100", "met at expo"),
            Contact("Ben Ode", "ben@example.com"),
        ]
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "out.csv")
            self.assertEqual(export_contacts(people, path), 2)
            self.assertEqual(import_contacts(path), people)

    def test_legacy_export_with_reordered_and_missing_columns(self):
        got = import_contacts(os.path.join(HERE, "legacy_export.csv"))
        self.assertEqual(got, [
            Contact("Jo Park", "jo@example.org", "Parkside Bakery", "555-0101", ""),
            Contact("Li Wei", "li@example.net", "", "", ""),
        ])

    def test_empty_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "empty.csv")
            open(path, "w").close()
            self.assertEqual(import_contacts(path), [])


if __name__ == "__main__":
    unittest.main()
