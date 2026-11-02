# AlcorFinance

![AlcorFinance](../../screenshots/AlcorFinance.png)

Three small calculators that answer real questions: **opportunity cost** (what your money could
have made elsewhere), **loan** schedules, and **break-even** analysis. Results can be copied as a
link, downloaded as CSV or printed.

## How it works

`alcor-finance-core.js` holds the maths and validation with no DOM; `alcor-finance.js` is the
UI. State lives in the page and the share link, never on a server.

## The hard parts

- **Money that adds up.** Amounts are rounded to cents at defined points (`roundCents`) and
  formatted consistently (`formatMoney`, `formatPercent`), so tables and totals agree.
- **Strict number parsing.** `parseNumber` accepts currency signs and thousands separators but
  rejects ambiguous input such as misplaced commas (`hasBadComma`), with a clear message
  (`numberError`) instead of a silent wrong answer.
- **Bounded inputs.** `checkAmount`, `checkRate` and `checkGrowthYears` keep results meaningful.

## Run

Serve `AlcorApps/web` with any static server and open `AlcorFinance/`. An example is loaded.
