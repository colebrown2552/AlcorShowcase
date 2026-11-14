# Renewal dates slide to the 28th and never come back

From the billing team: a customer who subscribed on 31 January 2025 on the
monthly plan was renewed on 28 February (fine, February is short), but then
on 28 March, 28 April, 28 May and so on. They should have been renewed on
31 March, 30 April, 31 May... The same happens to quarterly and yearly plans
that start on a day that some later month does not have (a yearly plan
started on 29 February is on the 28th forever, even in leap years).

Renewals are supposed to stay anchored to the day of the month the
subscription started, falling back to the last day of the month only when
that month is too short.

Files: `subs/schedule.py` (`renewal_dates(start, plan, count)` and
`next_renewal(start, plan, after)`), `subs/calendar_utils.py` (month
arithmetic), `subs/plans.py` (plan definitions) and `subs/billing.py`, which
builds upcoming charges from the schedule.

Done means: both functions in `subs/schedule.py` return dates anchored to
the start date as described, for every plan length, across year boundaries
and leap years; `next_renewal` still returns the first renewal strictly after
`after`. Signatures stay the same. `tests/test_calendar.py` must keep passing
(`python3 -m unittest discover -s tests -t .`).
