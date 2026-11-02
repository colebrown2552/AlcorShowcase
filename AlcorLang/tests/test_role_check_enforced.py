"""The shipped periodic table must carry roles, and they must bite.

A table with no role data cannot tell a verb from an object, so ``canon_element``
canonicalized a token and then let it stand in either position. That made
``Computer Update`` as legal as ``Update Computer``. These tests pin the two
halves of the repair: the table says which elements are verbs and which are
objects, and the parser refuses a token used in the wrong position.
"""

from __future__ import annotations

import unittest

from alcorlang.vocabulary import canon_element

import alcorlang as language


class RoleCheckEnforcedTests(unittest.TestCase):
    def test_table_reports_the_role_check_as_enforced(self):
        info = language.table()
        self.assertEqual(info["role_check"], "enforced")
        self.assertFalse(info["is_fallback"], info["source"])

    def test_an_object_is_rejected_in_the_verb_position(self):
        with self.assertRaises(language.AlcorLangError):
            canon_element("Computer", "verb")

    def test_a_verb_is_rejected_in_the_object_position(self):
        with self.assertRaises(language.AlcorLangError):
            canon_element("Update", "object")

    def test_a_verb_still_canonicalizes_in_the_verb_position(self):
        self.assertEqual(canon_element("Update", "verb"), "Update")
        self.assertEqual(canon_element("WRITE", "verb"), "Update")

    def test_message_holds_both_roles_because_the_corpus_uses_both(self):
        # SEND aliases to Message, so this one element has to pass in either
        # position or the v2 conformance corpus stops parsing.
        self.assertEqual(canon_element("SEND", "verb"), "Message")
        self.assertEqual(canon_element("Message", "object"), "Message")
        both = language.parse('SEND Message "hi" TO Person ada')["body"][0]
        self.assertEqual(both["verb"], "Message")
        self.assertEqual(both["object"], "Message")
        self.assertEqual(both["tail"]["object"], "Person")

    def test_a_wrong_role_fails_the_parse_and_not_just_the_lookup(self):
        # The tail object after TO/FROM is checked in the object position too.
        with self.assertRaises(language.AlcorLangError):
            language.parse('WRITE Message "hi" TO Update t.txt')
        with self.assertRaises(language.AlcorLangError):
            language.parse('Computer Update "x"')

    def test_every_element_the_repo_corpus_uses_carries_the_right_role(self):
        # Measured, not guessed: these are the verb and object positions that
        # actually occur across the repo's .alcor files and the conformance
        # corpus. Enforcement must not narrow any of them.
        for verb in (
            "Update",
            "View",
            "Message",
            "Search",
            "Hunt",
            "Learn",
            "Relay",
            "PrimeProjection",
        ):
            self.assertEqual(canon_element(verb, "verb"), verb)
        for obj in (
            "Computer",
            "File",
            "Task",
            "Wishlist",
            "Message",
            "Person",
            "Repo",
            "Web",
            "Question",
            "Fact",
            "Source",
            "Window",
        ):
            self.assertEqual(canon_element(obj, "object"), obj)


if __name__ == "__main__":
    unittest.main()
