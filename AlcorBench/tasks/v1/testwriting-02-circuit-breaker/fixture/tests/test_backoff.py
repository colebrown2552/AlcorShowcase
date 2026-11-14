import unittest

from guard.backoff import backoff_delays


class BackoffTests(unittest.TestCase):
    def test_doubles_until_cap(self):
        self.assertEqual(backoff_delays(), [0.5, 1.0, 2.0, 4.0, 8.0])
        self.assertEqual(backoff_delays(attempts=7)[-2:], [8.0, 8.0])

    def test_no_attempts(self):
        self.assertEqual(backoff_delays(attempts=0), [])


if __name__ == "__main__":
    unittest.main()
