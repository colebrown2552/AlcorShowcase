# AlcorReconcile

![AlcorReconcile](../../screenshots/AlcorReconcile.png)

Compares two CSV exports, for example invoices against payments, and flags matches, amount
mismatches and records missing on either side. Results download as CSV.

## How it works

`alcor-reconcile-core.js` is the engine (parsing, matching, money maths, export) with no DOM;
`alcor-reconcile.js` is the UI. Files are read in the browser and never uploaded.

## The hard parts

- **Exact money maths.** Amounts are parsed into integers with `BigInt` (`parseDecimal`),
  compared exactly, rounded with banker's rounding (`roundHalfEven`) and printed back with
  `decimalToString`. No floating-point errors, ever.
- **A strict CSV scanner.** `scanCsv` handles quoted fields, embedded newlines and escaped quotes
  and rejects malformed input instead of guessing.
- **Safe exports.** `csvField` neutralises any value that starts with `=`, `+`, `-` or `@` (even
  after leading spaces or control characters) or with a tab or carriage return (`FORMULA_START`),
  so a downloaded report can't run a formula when opened in a spreadsheet (CSV injection).

## Run

Serve `AlcorApps/web` with any static server, open `AlcorReconcile/` and choose
**Load sample data**.
