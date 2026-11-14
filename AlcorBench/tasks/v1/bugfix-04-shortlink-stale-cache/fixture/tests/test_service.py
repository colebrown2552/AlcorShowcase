import unittest

from shortener.service import LinkService


class ServiceTests(unittest.TestCase):
    def test_generated_codes_are_distinct(self):
        svc = LinkService()
        a = svc.shorten("https://example.com/a")
        b = svc.shorten("https://example.com/b")
        self.assertNotEqual(a, b)
        self.assertEqual(svc.resolve(a), "https://example.com/a")

    def test_custom_code_is_case_insensitive(self):
        svc = LinkService()
        code = svc.shorten("https://example.com/sale", code="Big-Sale")
        self.assertEqual(code, "big-sale")
        self.assertEqual(svc.resolve("BIG-sale"), "https://example.com/sale")

    def test_unknown_code(self):
        with self.assertRaises(KeyError):
            LinkService().resolve("nope")

    def test_rejects_non_http(self):
        with self.assertRaises(ValueError):
            LinkService().shorten("ftp://example.com")

    def test_update_same_spelling(self):
        svc = LinkService()
        svc.shorten("https://example.com/old", code="docs")
        svc.resolve("docs")
        svc.update_target("docs", "https://example.com/new")
        self.assertEqual(svc.resolve("docs"), "https://example.com/new")

    def test_delete_unknown_raises(self):
        with self.assertRaises(KeyError):
            LinkService().delete("ghost")


if __name__ == "__main__":
    unittest.main()
