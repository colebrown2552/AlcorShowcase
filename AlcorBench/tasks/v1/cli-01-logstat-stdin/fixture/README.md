# logstat

Counts log lines per level for the nightly job report.

    python3 logstat.py app.log
    python3 logstat.py app.log --level ERROR

Log lines look like `2026-03-01T12:00:00 ERROR something broke`. Lines that do not
have a known level in the second field are skipped.
