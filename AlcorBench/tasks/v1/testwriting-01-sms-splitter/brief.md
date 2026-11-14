# Add tests for `split_sms`

`notify/sms.py` splits long notification texts into SMS-sized parts. It has
no tests, and we are about to switch SMS providers (the new one has a
different length limit), so we want its current behaviour pinned down before
anyone touches it. The function is correct today; please do not change it.

Write the tests in a new file `tests/test_sms.py`, using `unittest` like the
existing `tests/test_quiet_hours.py`. They must pass against the current code
and run with:

    python3 -m unittest discover -s tests -t .

Done means: the tests cover every rule in the `split_sms` docstring
(whitespace handling, the empty case, short texts, the `(i/n)` counters and
the length limit including them, where parts are broken, very long words,
and the error case), with concrete expected values, so that a change that
breaks any one of those rules makes the suite fail.
