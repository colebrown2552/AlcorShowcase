# csvlint

Checks CSV exports before the warehouse load picks them up.

    python3 csvlint.py samples/orders.csv --require customer
    python3 csvlint.py exports/*.csv --require order_id --require total -q

Checks: the file has a header, every required column exists, every row has as
many fields as the header, and required columns are not empty. Blank lines are
ignored.
