The subscriber export for the Fernbrook Allotment Society newsletter has duplicates that `clean_list.py` doesn't catch, and when it does catch one it keeps the wrong row. Please fix the de-duplication in `listtools/dedupe.py`.

How it should work:
- Two rows are the same subscriber when their emails match after trimming surrounding whitespace and lower-casing. Nothing else is normalised (`tomas.r+news@...` and `tomas.r@...` are different people).
- Of the duplicates, keep the row with the latest `signed_up` (format `YYYY-MM-DD HH:MM:SS`). If two rows have the same `signed_up`, keep the one that comes later in the file.
- The kept row's `email` is written in its normalised form (trimmed, lower-case); the other fields are written as they are in the kept row.
- Rows with a blank email are dropped.
- Output order: one row per subscriber, in the order in which each subscriber first appears in the input.

The command is unchanged: `python3 clean_list.py INPUT_CSV OUTPUT_CSV`, writing the columns `email,name,signed_up,source`.

`tests/test_dedupe.py` describes the intended behaviour (`python3 -m unittest`) and `samples/subscribers.csv` is a real-looking export; please don't modify either. Done means duplicates are merged by these rules for any export, not just the sample.
