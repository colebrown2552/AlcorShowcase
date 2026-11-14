`flatten_readings.py` is only a skeleton. Please implement it so the growers get a CSV table from the controllers' JSON Lines files.

Interface: `python3 flatten_readings.py READINGS_JSONL OUTPUT_CSV`.

Input: one JSON object per line. Blank lines (empty or whitespace only) are skipped. Objects can be nested to any depth; lists only ever contain plain values (strings, numbers, booleans, null).

Flattening rules:
- Nested object keys are joined with `.`: `{"reading": {"temp": {"c": 18.5}}}` becomes the column `reading.temp.c`. An empty nested object adds no columns.
- Lists become one cell: the items converted by the rules below and joined with `|`. An empty list is an empty cell.
- `null` is an empty cell, `true`/`false` are written as `true`/`false`, numbers are written the way Python's `str()` writes them (`18.5`, `71`, `19.0`), strings as they are.

Output table:
- Columns are `device` and `ts` first, then every other column that appears in any record, sorted by plain string order (Python's `sorted()`).
- One row per record, in input order; a record that lacks a column gets an empty cell.
- Standard CSV quoting (values may contain commas and quotes).
- If the file has no records, write just the header `device,ts`.
- If a line is not valid JSON, print `line N: invalid JSON` to stderr (N = 1-based line number in the file, counting blank lines) and exit with status 1.

`samples/readings.jsonl` and `samples/readings.csv` are a real example of input and expected output; please don't edit them. Done means the sample converts to the same table and other files from the controllers convert by the same rules.
