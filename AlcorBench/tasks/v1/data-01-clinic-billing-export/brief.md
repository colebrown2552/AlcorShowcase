Our billing provider changed their upload format, and `export_for_billing.py` still writes the old one. Please update the script so the file it writes matches the new format.

Usage stays the same: `python3 export_for_billing.py APPOINTMENTS_CSV OUTPUT_CSV`. The input is the booking system export described in `README.md`.

The output CSV must have exactly these columns, in this order:

`visit_id,visit_date,patient_ref,duration_min,fee_pence`

- `visit_id`: the `appt_id`, trimmed.
- `visit_date`: `appt_date` is `DD/MM/YYYY` (day and month may be one or two digits); write it as `YYYY-MM-DD`.
- `patient_ref`: trimmed and upper-cased.
- `duration_min`: `length` is whole minutes but sometimes arrives as `30.0` or with spaces; write a plain integer (`30`).
- `fee_pence`: `fee_gbp` is pounds, sometimes with a leading `£` (possibly followed by a space), sometimes blank. Write the exact amount in pence as an integer (`19.99` -> `1999`, blank -> `0`). Watch out for floating-point rounding.
- `clinician` and `notes` are dropped. Notes can contain quoted commas.

Rows keep their input order. The header row is always written, even when the export has no appointments.

`samples/appointments.csv` and the expected output `samples/billing_expected.csv` show the new format; please don't change them. Done means the sample converts to the same rows as the expected file and any other export in the same format converts by the same rules.
