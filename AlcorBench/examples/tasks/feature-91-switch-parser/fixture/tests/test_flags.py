import unittest

from settings.flags import flag_from_env


class FlagFromEnvTest(unittest.TestCase):
    def test_missing_uses_default(self):
        self.assertTrue(flag_from_env({}, "DEBUG", default=True))

    def test_blank_uses_default(self):
        self.assertFalse(flag_from_env({"DEBUG": "  "}, "DEBUG"))


if __name__ == "__main__":
    unittest.main()
