The garden committee wants a monthly summary of volunteer hours, and `hours_report.py` stops at a TODO. Please finish it.

Interface: `python3 hours_report.py SHIFTS_CSV REPORT_CSV [--plot NAME]`. Read the shift log with `load_shifts` from `garden/shifts.py` (it already handles parsing; don't change it).

The report is a CSV pivot table:
- Header: `volunteer`, then one column per month that has counted hours, named `YYYY-MM`, in ascending order, then `total`.
- One row per volunteer (name as returned by `load_shifts`), rows sorted by name with Python's default string ordering.
- Each cell is that volunteer's total hours for the month, written with exactly one decimal place (`3.5`, `0.0` when they worked no hours that month). `total` is the row total.
- A last row `TOTAL` holds the sum of each column and the grand total, same formatting.
- Shifts whose hours are blank are not counted at all: a volunteer or month that only has blank shifts does not appear.
- `--plot NAME` counts only shifts on that plot (exact match). Without it, all plots count.
- If nothing is counted (empty log, or no shift on the given plot), the report is the header `volunteer,total` and the row `TOTAL,0.0`.

Hours are always multiples of 0.5, so one decimal is exact. Exit status 0 on success.

Example for `samples/shifts.csv` (no `--plot`):

```
volunteer,2026-03,2026-04,total
Mae Holt,4.0,2.0,6.0
Ola Fenn,0.0,4.0,4.0
Ravi Dunn,3.0,0.0,3.0
TOTAL,7.0,6.0,13.0
```

Done means the command writes this report for any shift log and plot filter.
