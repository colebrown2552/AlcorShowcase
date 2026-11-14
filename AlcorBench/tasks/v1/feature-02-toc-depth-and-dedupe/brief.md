Two problems with the docs table of contents (`mdtoc`):

1. Pages repeat headings ("Example", "Options" under each command), and every repeat gets the same anchor, so the TOC links all jump to the first one.
2. Most pages want a TOC of only the `##`/`###` sections, without the page title.

Please extend `build_toc` in `mdtoc/render.py`:

**Signature:** `build_toc(text, min_level=1, max_level=6)`. Called without the new arguments it must behave as today except for the duplicate fix below.

**Duplicate anchors.** Use GitHub's rule: going through the document's headings in order, the first heading with a given slug keeps it; the next one with the same slug gets `<slug>-1`, then `<slug>-2`, and so on. Counting covers *every* heading in the document, including headings left out of the TOC by the level range, because the anchors exist on the rendered page either way.

**Level range.** Only headings with `min_level <= level <= max_level` appear. Indentation is relative to `min_level`: a heading at `min_level` has no indent, and each level deeper adds two spaces. Raise `ValueError` unless `1 <= min_level <= max_level <= 6`.

Line format stays `<indent>- [<title>](#<anchor>)`, lines joined by `\n` with a trailing newline, and `""` when nothing is listed.

Example: for a page with `# Tool`, `## Usage`, `### Example`, `## Config`, `### Example`, `build_toc(text, min_level=2)` returns

```
- [Usage](#usage)
  - [Example](#example)
- [Config](#config)
  - [Example](#example-1)
```

Heading detection (`headings.py`) and slug rules (`slug.py`) are fine as they are. The tests in `tests/test_toc.py` must keep passing; don't change them.
