"""Exporter classes. Each takes its options as keyword arguments and renders rows to text."""
import csv
import io
import json


def columns(rows):
    """Column names in first-seen order across all rows."""
    names = []
    for row in rows:
        for key in row:
            if key not in names:
                names.append(key)
    return names


def cell_text(value):
    return "" if value is None else str(value)


class CsvExporter:
    def __init__(self, delimiter, header):
        self.delimiter = delimiter
        self.header = header

    def render(self, rows):
        if not rows:
            return ""
        names = columns(rows)
        out = io.StringIO()
        writer = csv.writer(out, delimiter=self.delimiter, lineterminator="\n")
        if self.header:
            writer.writerow(names)
        for row in rows:
            writer.writerow([cell_text(row.get(name)) for name in names])
        return out.getvalue()


class JsonExporter:
    def __init__(self, indent, sort_keys):
        self.indent = indent
        self.sort_keys = sort_keys

    def render(self, rows):
        return json.dumps(rows, indent=self.indent, sort_keys=self.sort_keys, default=str) + "\n"
