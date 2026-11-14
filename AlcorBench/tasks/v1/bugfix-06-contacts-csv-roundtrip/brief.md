# Address book export/import corrupts some contacts

Two tickets that turn out to be the same problem:

- Sales exported the address book, opened it in a spreadsheet and found the
  columns shifted for anyone whose company is written like
  `Hartley, Webb & Sons` or whose notes contain a comma. Notes with a line
  break started a new row.
- Re-importing our own export into the staging instance produced wrong
  contacts: `"Acme" Holdings` came back with mangled quotes, a note split
  over two lines turned into a broken extra contact, and some phone numbers
  ended up in the notes field.

The code is the `addressbook` package: `addressbook/models.py` (the
`Contact` fields), `addressbook/exporter.py` (`export_contacts(contacts,
path)`), `addressbook/importer.py` (`import_contacts(path)`) and
`addressbook/cli.py`.

Done means: the export is a CSV file (header row with the field names, then
one record per contact) that spreadsheet tools and other CSV readers parse
correctly, and importing an export gives back exactly the
contacts that were exported, whatever text the fields contain (commas,
double quotes, line breaks, non-ASCII names, empty fields). The importer must
keep accepting the files it accepts today: columns in any order, columns
missing from older exports (those fields become empty), and blank lines
between records. `tests/test_roundtrip.py` and the sample old export it uses
must keep working (`python3 -m unittest discover -s tests -t .`).
