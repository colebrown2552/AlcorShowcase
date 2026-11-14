# Split up `build_payslips`

`payroll/payslips.py` has a single function, `build_payslips`, that is about
140 lines long: it reads the employee list, reads and validates the
timesheet, splits hours into regular / overtime / holiday time, works out
gross pay, tax and pension, and formats the whole report. Next quarter we
need to add a second pay rule set and a CSV output, and nobody wants to do
that inside this function.

Please restructure the module into smaller functions with clear jobs (how
you cut it is up to you). The pay rules live in `payroll/rates.py`;
`payroll/cli.py` is the command-line entry point.

Constraints:

- Pure refactor. `build_payslips(timesheet_csv, employees_csv, period_label,
  holidays=())` keeps its signature and returns exactly the same text as
  today for every input, including the warnings for bad rows, rounding,
  the order of payslips and of warnings, and the "No hours recorded" line.
  The command line output must not change either.
- No function or method anywhere in `payroll/` may be longer than 40 lines
  (counting from its `def` line to its last line, docstring included).
  Keep normal formatting while doing it: one statement per line (no `;`
  and no `if x: y` one-liners) and no line longer than 110 characters.
- Standard library only; keep everything inside the `payroll` package.

Done means: the module is split up as described, every function is at most
40 lines, and the report output is unchanged. `tests/test_payslips.py` must
keep passing (`python3 -m unittest discover -s tests -t .`); it only covers a
few cases, so compare outputs on more varied data yourself before and after
the change.
