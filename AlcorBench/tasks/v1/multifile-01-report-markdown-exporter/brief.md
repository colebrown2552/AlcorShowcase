People keep pasting our CSV reports into wiki pages by hand. Please add a `markdown` export format to `reportkit` so `export(rows, "markdown")` produces a Markdown table.

Formats in this package are wired up in several places, and all of them need the new one:

- the exporter classes in `reportkit/exporters.py`,
- the format registry in `reportkit/registry.py`,
- the per-format default options in `reportkit/config.py` (options not listed there are rejected),
- the format list in `docs/formats.md`, which must list every registered format with all of its options (`tests/test_reportkit.py` enforces this).

**Output.** For a non-empty list of rows, the result is one header line, one alignment line, then one line per row, each line ending in `\n`:

```
| name | qty |
| :--- | :--- |
| apple | 3 |
| pear |  |
```

- Columns and cell values follow the same rules as the CSV exporter: column names in first-seen order across all rows (`columns()`), a key missing from a row or a `None` value gives an empty cell, other values go through `str()`.
- Each line is `| ` + cells joined by ` | ` + ` |`. So an empty cell shows as two spaces between the bars, as above.
- In header and data cells, a `|` character is escaped as `\|` and a newline is replaced by a single space.
- An empty list of rows gives `""`.

**Option `align`** (default `"left"`): sets the alignment line, the same marker in every column: `"left"` -> `:---`, `"right"` -> `---:`, `"center"` -> `:---:`. Any other value raises `ValueError` when exporting. Unknown option names raise `ValueError` the same way they do for the other formats.

`available_formats()` must include `"markdown"`. Done means the new format works through `export`, the existing formats are unchanged, and `python3 -m unittest discover -s tests` passes without editing the tests.
