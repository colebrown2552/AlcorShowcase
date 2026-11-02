from __future__ import annotations

import json
import unittest
from pathlib import Path

import alcorlang as RUNTIME

ALCORLANG_DIR = Path(__file__).resolve().parents[1]
PROGRAM_DIR = ALCORLANG_DIR / "programs"
MANIFEST_PATH = PROGRAM_DIR / "corpus.json"


def _inert_gate(seq, descriptor, resolved):
    # A directive program has effects. The default gate would write receipt files into the
    # working directory, so the corpus run uses a gate that records nothing and writes nothing.
    return {"outcome": "refused", "reason_code": "corpus_test_gate"}


CONTEXT = RUNTIME.ExecutionContext.conformance(gate_adapter=_inert_gate)


def _walk_statements(statements):
    for statement in statements:
        yield statement
        if statement["type"] == "loop_while":
            yield from _walk_statements(statement["body"])


class ProgramCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        cls.cases = cls.manifest["programs"]

    def test_manifest_covers_every_program(self):
        listed = {case["file"] for case in self.cases}
        present = {path.name for path in PROGRAM_DIR.glob("*.alcor")}
        self.assertEqual(present, listed)

    def test_exact_program_outcomes(self):
        for case in self.cases:
            with self.subTest(program=case.get("name", case["file"])):
                path = PROGRAM_DIR / case["file"]
                source = path.read_text(encoding="utf-8")
                input_text = "".join(line + "\n" for line in case.get("input", []))
                if case["mode"] == "run":
                    expected = "\n".join(case["expected_output"]) + "\n"
                    actual = RUNTIME.run(
                        source, input_text, base_dir=str(PROGRAM_DIR), context=CONTEXT
                    )
                    self.assertEqual(actual, expected)
                    continue

                if case["mode"] == "metered":
                    actual = RUNTIME.run_metered(
                        source,
                        input_text,
                        base_dir=str(PROGRAM_DIR),
                        context=CONTEXT,
                    )
                    for key, expected in case["expected"].items():
                        self.assertEqual(actual[key], expected, key)
                    continue

                self.fail("unknown corpus mode {!r}".format(case["mode"]))

    def test_policy_programs_are_default_profile_and_effect_free(self):
        for case in self.cases:
            if case["kind"] != "policy":
                continue
            with self.subTest(program=case.get("name", case["file"])):
                path = PROGRAM_DIR / case["file"]
                source = path.read_text(encoding="utf-8")
                module = RUNTIME.parse(source, base_dir=str(PROGRAM_DIR))
                blocks = [item for item in module["body"] if item["type"] == "program"]
                self.assertTrue(blocks)
                for block in blocks:
                    # Spelling out `profile=default` is allowed; anything else is not.
                    self.assertEqual(block["props"].get("profile", "default"), "default")
                    self.assertNotIn("authority", block["props"])
                    self.assertNotIn("fuel", block["props"])
                    statement_types = {
                        statement["type"] for statement in _walk_statements(block["body"])
                    }
                    self.assertNotIn("v1", statement_types)
                    self.assertNotIn("loop_while", statement_types)


if __name__ == "__main__":
    unittest.main()
