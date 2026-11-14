import unittest

from notify.sms import split_sms


class SplitSmsTests(unittest.TestCase):
    def test_short_text_single_part_without_counter(self):
        self.assertEqual(split_sms("Your parcel has shipped."), ["Your parcel has shipped."])

    def test_exactly_at_limit_is_single_part(self):
        text = "x" * 25
        self.assertEqual(split_sms(text, limit=25), [text])

    def test_whitespace_collapsed_and_stripped(self):
        self.assertEqual(split_sms("  Hello \n\n there\tfriend  "), ["Hello there friend"])

    def test_empty_and_blank(self):
        self.assertEqual(split_sms(""), [])
        self.assertEqual(split_sms(" \n\t "), [])

    def test_splits_at_spaces_with_counters(self):
        text = "alpha beta gamma delta epsilon zeta eta theta"
        self.assertEqual(split_sms(text, limit=24), [
            "alpha beta gamma (1/3)",
            "delta epsilon zeta (2/3)",
            "eta theta (3/3)",
        ])

    def test_every_part_within_limit_including_counter(self):
        text = " ".join(f"word{i}" for i in range(400))
        for limit in (20, 37, 70, 160):
            parts = split_sms(text, limit=limit)
            self.assertGreater(len(parts), 1)
            for i, part in enumerate(parts, start=1):
                self.assertLessEqual(len(part), limit)
                self.assertTrue(part.endswith(f" ({i}/{len(parts)})"))
            joined = " ".join(p.rsplit(" (", 1)[0] for p in parts)
            self.assertEqual(joined, text)

    def test_long_word_split_hard(self):
        self.assertEqual(split_sms("a" * 30, limit=20), ["a" * 14 + " (1/3)", "a" * 14 + " (2/3)", "aa (3/3)"])

    def test_limit_too_small(self):
        with self.assertRaises(ValueError):
            split_sms("hello", limit=19)


if __name__ == "__main__":
    unittest.main()
