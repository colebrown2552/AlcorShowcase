# Test coverage for `CircuitBreaker`

Our service wraps calls to the payments provider in
`guard/breaker.py` (`CircuitBreaker`) so that a provider outage does not
pile up hanging requests. `guard/backoff.py` has tests
(`tests/test_backoff.py`); the breaker has none. We are about to rewrite it
to be thread-safe, and we want a suite that pins down today's behaviour so
the rewrite can be checked against it.

Please add `tests/test_breaker.py` (plain `unittest`) that tests
`CircuitBreaker` directly. The code is believed correct; do not modify it.
The tests must be deterministic and fast: never sleep, drive time through the
`clock` argument instead. The suite runs with

    python3 -m unittest discover -s tests -t .

Done means: the behaviour described in the class docstring is pinned down
with concrete expectations: the closed / open / half-open states and the
`state` property, when it opens (consecutive failures only), how long it
stays open, the single trial call in half-open and what success or failure
of that trial does (including the timing after a failed trial), `call()`
including the exception it raises when open and passing through the wrapped
function's own exceptions, and the `ValueError` cases. A rewrite that gets
any one of those wrong should make the suite fail.
