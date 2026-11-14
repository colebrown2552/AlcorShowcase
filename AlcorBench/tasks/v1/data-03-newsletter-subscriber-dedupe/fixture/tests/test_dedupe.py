import unittest

from listtools.dedupe import dedupe


def row(email, signed_up, name="", source="web"):
    return {"email": email, "name": name, "signed_up": signed_up, "source": source}


class DedupeTest(unittest.TestCase):
    def test_case_and_spaces_are_the_same_address(self):
        out = dedupe([row("Ivy@Example.org ", "2026-01-05 10:00:00"), row("ivy@example.org", "2026-02-01 09:30:00")])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["email"], "ivy@example.org")

    def test_newest_signup_wins(self):
        out = dedupe([row("a@example.net", "2026-03-01 08:00:00", name="new"),
                      row("A@example.net", "2025-12-24 18:00:00", name="old")])
        self.assertEqual([r["name"] for r in out], ["new"])


if __name__ == "__main__":
    unittest.main()
