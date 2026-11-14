import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from minitpl import TemplateError, render  # noqa: E402


class Obj:
    plan = "pro"


class RenderTests(unittest.TestCase):
    def test_plain_and_dotted(self):
        ctx = {"user": {"name": "Ada", "account": Obj()}, "n": 3}
        self.assertEqual(render("{{user.name}} has {{ n }} on {{ user.account.plan }}", ctx),
                         "Ada has 3 on pro")

    def test_none_renders_empty(self):
        self.assertEqual(render("[{{ x }}]", {"x": None}), "[]")

    def test_missing_is_error(self):
        with self.assertRaises(TemplateError):
            render("{{ nope }}", {})

    def test_bad_expression(self):
        with self.assertRaises(TemplateError):
            render("{{ 1abc }}", {})


if __name__ == "__main__":
    unittest.main()
