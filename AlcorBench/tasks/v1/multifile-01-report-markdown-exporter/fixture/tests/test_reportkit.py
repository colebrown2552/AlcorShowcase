import os
import sys
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, ROOT)

from reportkit import available_formats, export  # noqa: E402
from reportkit.config import DEFAULTS  # noqa: E402

ROWS = [{"name": "apple", "qty": 3}, {"name": "pear", "note": None}]


class ExportTests(unittest.TestCase):
    def test_csv(self):
        self.assertEqual(export(ROWS, "csv"), "name,qty,note\napple,3,\npear,,\n")
        self.assertEqual(export(ROWS, "csv", delimiter=";", header=False), "apple;3;\npear;;\n")

    def test_json(self):
        self.assertTrue(export(ROWS, "json", indent=None).startswith('[{"name": "apple"'))

    def test_unknown(self):
        with self.assertRaises(ValueError):
            export(ROWS, "xml")
        with self.assertRaises(ValueError):
            export(ROWS, "csv", colour="red")


class DocsTests(unittest.TestCase):
    """docs/formats.md must list every registered format with every option."""

    def test_formats_documented(self):
        with open(os.path.join(ROOT, "docs", "formats.md")) as handle:
            rows = [line for line in handle if line.startswith("| `")]
        documented = {line.split("`")[1]: line for line in rows}
        self.assertEqual(sorted(documented), available_formats())
        for fmt in available_formats():
            self.assertIn(fmt, DEFAULTS)
            for option in DEFAULTS[fmt]:
                self.assertIn("`%s`" % option, documented[fmt], (fmt, option))


if __name__ == "__main__":
    unittest.main()
