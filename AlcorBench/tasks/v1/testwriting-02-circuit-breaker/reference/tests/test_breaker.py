import unittest

from guard.breaker import CircuitBreaker, CircuitOpenError


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def boom():
    raise ConnectionError("provider down")


class CircuitBreakerTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.cb = CircuitBreaker(failure_threshold=3, reset_timeout=10, clock=self.clock)

    def fail(self, n=1):
        for _ in range(n):
            self.cb.record_failure()

    def test_starts_closed(self):
        self.assertEqual(self.cb.state, "closed")
        self.assertTrue(self.cb.allow())

    def test_opens_at_threshold(self):
        self.fail(2)
        self.assertEqual(self.cb.state, "closed")
        self.fail()
        self.assertEqual(self.cb.state, "open")
        self.assertFalse(self.cb.allow())

    def test_only_consecutive_failures_count(self):
        self.fail(2)
        self.cb.record_success()
        self.fail(2)
        self.assertEqual(self.cb.state, "closed")
        self.fail()
        self.assertEqual(self.cb.state, "open")

    def test_stays_open_until_timeout(self):
        self.fail(3)
        self.clock.now += 9.99
        self.assertEqual(self.cb.state, "open")
        self.assertFalse(self.cb.allow())
        self.clock.now += 0.01
        self.assertEqual(self.cb.state, "half_open")

    def test_half_open_allows_exactly_one_trial(self):
        self.fail(3)
        self.clock.now += 10
        self.assertTrue(self.cb.allow())
        self.assertFalse(self.cb.allow())
        self.assertFalse(self.cb.allow())

    def test_trial_success_closes(self):
        self.fail(3)
        self.clock.now += 10
        self.cb.allow()
        self.cb.record_success()
        self.assertEqual(self.cb.state, "closed")
        self.fail(2)
        self.assertEqual(self.cb.state, "closed")

    def test_trial_failure_reopens_for_full_timeout(self):
        self.fail(3)
        self.clock.now += 25
        self.assertTrue(self.cb.allow())
        self.cb.record_failure()
        self.assertEqual(self.cb.state, "open")
        self.assertFalse(self.cb.allow())
        self.clock.now += 9.5
        self.assertEqual(self.cb.state, "open")
        self.clock.now += 0.5
        self.assertEqual(self.cb.state, "half_open")
        self.assertTrue(self.cb.allow())

    def test_call_returns_and_records(self):
        self.assertEqual(self.cb.call(lambda a, b=0: a + b, 2, b=3), 5)
        for _ in range(3):
            with self.assertRaises(ConnectionError):
                self.cb.call(boom)
        self.assertEqual(self.cb.state, "open")

    def test_call_when_open_does_not_call(self):
        self.fail(3)
        calls = []
        with self.assertRaises(CircuitOpenError):
            self.cb.call(lambda: calls.append(1))
        self.assertEqual(calls, [])

    def test_call_in_half_open(self):
        self.fail(3)
        self.clock.now += 10
        self.assertEqual(self.cb.call(lambda: "ok"), "ok")
        self.assertEqual(self.cb.state, "closed")

    def test_invalid_arguments(self):
        with self.assertRaises(ValueError):
            CircuitBreaker(failure_threshold=0, clock=self.clock)
        with self.assertRaises(ValueError):
            CircuitBreaker(reset_timeout=0, clock=self.clock)
        with self.assertRaises(ValueError):
            CircuitBreaker(reset_timeout=-1, clock=self.clock)

    def test_threshold_one(self):
        cb = CircuitBreaker(failure_threshold=1, reset_timeout=1, clock=self.clock)
        cb.record_failure()
        self.assertEqual(cb.state, "open")


if __name__ == "__main__":
    unittest.main()
