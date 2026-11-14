import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mdtoc import build_toc, extract_headings  # noqa: E402
from mdtoc.slug import slugify  # noqa: E402

DOC = """# Guide

Intro text.

## Install it

```sh
# not a heading
```

### On Linux
## FAQ's & tips ##
"""


class TocTests(unittest.TestCase):
    def test_headings_skip_fences(self):
        titles = [h.title for h in extract_headings(DOC)]
        self.assertEqual(titles, ["Guide", "Install it", "On Linux", "FAQ's & tips"])

    def test_slugify(self):
        self.assertEqual(slugify("FAQ's & tips"), "faqs--tips")
        self.assertEqual(slugify("Install it"), "install-it")

    def test_default_toc(self):
        self.assertEqual(build_toc(DOC), (
            "- [Guide](#guide)\n"
            "  - [Install it](#install-it)\n"
            "    - [On Linux](#on-linux)\n"
            "  - [FAQ's & tips](#faqs--tips)\n"))

    def test_empty(self):
        self.assertEqual(build_toc("no headings here\n"), "")


if __name__ == "__main__":
    unittest.main()
