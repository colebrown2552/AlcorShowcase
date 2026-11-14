import unittest

from numstat.center import mean, median


class CenterTest(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(mean([1, 2, 3, 6]), 3)

    def test_median_odd(self):
        self.assertEqual(median([9, 1, 5]), 5)

    def test_median_empty(self):
        with self.assertRaises(ValueError):
            median([])


if __name__ == "__main__":
    unittest.main()
