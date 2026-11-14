# Invoices are sometimes one cent short

A customer emailed us an invoice where a line for "Cable ties, 100 pack" at
4.35 each showed a unit price of 4.34, and the total was short accordingly.
Finance spot-checked a few more and found other prices doing the same thing
(they mentioned 0.29 and 1.15), while most prices are fine. Credits entered as
negative amounts seem to be affected too.

The invoice code is the `billing` package: `billing/money.py` turns the price
text we get from the order system (things like `"4.35"`, `"$1,019.99"`,
`"-2.30"` or `"(12.00)"` for credits) into integer cents, and
`billing/invoice.py` builds the invoice from those amounts.

Done means: every price with at most two decimal places is converted to
exactly the right number of cents, so line totals, tax and invoice totals are
correct. Input that is not an amount must still raise `ValueError` as it does
today. `tests/test_billing.py` must keep passing
(`python3 -m unittest discover -s tests -t .`).
