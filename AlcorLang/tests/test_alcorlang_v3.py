from __future__ import annotations

import json
import os
import re
import types
import unittest

import alcorlang.v3 as v3

HERE = os.path.dirname(os.path.abspath(__file__))
PROGRAMS = os.path.join(HERE, os.pardir, "programs")


def program(*body: str, header: str = "PROGRAM Demo") -> str:
    return "\n".join(["ALCOR 3", header, *body, "END PROGRAM", ""])


def payloads(lowered: str) -> list[dict]:
    result = []
    for line in lowered.splitlines():
        if not (line.startswith("Update Task ") or line.startswith("View Task ")):
            continue
        m = re.match(r'^(?:Update|View) Task ("(?:\\.|[^"])*") WITH ', line)
        if not m:
            raise AssertionError(f"not a directive effect line: {line}")
        result.append(json.loads(json.loads(m.group(1))))
    return result


class DirectiveTests(unittest.TestCase):
    def test_token_and_json_values(self):
        directives = v3.parse_directives(
            '.alcor.run(model="local:auto", stream=true, retries=2, '
            'source={language:"python", files:["a.py","b.py"]})'
        )
        self.assertEqual(len(directives), 1)
        p = directives[0].payload()
        self.assertEqual(p["name"], "run")
        self.assertEqual(p["kwargs"]["source"]["language"], "python")
        self.assertEqual(p["kwargs"]["source"]["files"], ["a.py", "b.py"])
        self.assertIs(p["kwargs"]["stream"], True)

    def test_sequence(self):
        ds = v3.parse_directives('.alcor.model("local") .alcor.status()')
        self.assertEqual([d.name for d in ds], ["model", "status"])

    def test_reference_is_data(self):
        d = v3.parse_directives(".alcor.memory(source=.alcor.thread)")[0]
        self.assertEqual(d.payload()["kwargs"]["source"], {"token_ref": "alcor.thread"})

    def test_unknown_directive_fails_closed(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "unknown .alcor directive"):
            v3.parse_directives('.alcor.shell("rm -rf /")')

    def test_duplicate_kwarg_rejected(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "duplicate"):
            v3.parse_directives('.alcor.run(model="a", model="b")')

    def test_credentials_rejected_without_echoing_value(self):
        dummy = "not-a-real-credential"
        source = f'.alcor.run(model="x", api_key={json.dumps(dummy)})'
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "credential-like field") as caught:
            v3.parse_directives(source)
        self.assertNotIn(dummy, str(caught.exception))

    def test_thread_traversal_rejected(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "unsafe"):
            v3.parse_directives('.alcor.thread("repo/../secrets")')

    def test_context_limit(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "max_input"):
            v3.parse_directives(".alcor.context(max_input=1000001)")

    def test_query_and_action_modes(self):
        lowered = v3.transpile(
            program(
                '.alcor.model("local")',
                '.alcor.run(prompt="hello")',
                ".alcor.status()",
            )
        )
        lines = lowered.splitlines()
        self.assertTrue(
            any(line.startswith("Update Task ") and "mode=action" in line for line in lines)
        )
        self.assertTrue(
            any(line.startswith("View Task ") and "mode=query" in line for line in lines)
        )

    def test_run_requires_model_or_profile(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "requires a prior"):
            v3.transpile(program('.alcor.run(prompt="hello")'))

    def test_positional_select_resolves_profile(self):
        lowered = v3.transpile(
            program(
                '.alcor.select("local")',
                '.alcor.run(prompt="hello")',
            )
        )
        self.assertEqual([p["name"] for p in payloads(lowered)], ["select", "run"])

    def test_translate_requires_source_and_target(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "resolved source and target"):
            v3.transpile(program('.alcor.translate(source="stdin")'))

    def test_translate_with_bindings(self):
        lowered = v3.transpile(
            program(
                '.alcor.source(language="python", path="stdin")',
                '.alcor.target(language="alcor")',
                ".alcor.translate(verify=true)",
            )
        )
        self.assertEqual([p["name"] for p in payloads(lowered)], ["source", "target", "translate"])

    def test_unresolved_token_reference_rejected_during_transpile(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "unbound token"):
            v3.transpile(
                program(
                    ".alcor.translate(source=.alcor.source, target=.alcor.target)",
                )
            )

    def test_resolved_token_references_are_accepted(self):
        lowered = v3.transpile(
            program(
                '.alcor.source(language="python", path="stdin")',
                '.alcor.target(language="alcor")',
                ".alcor.translate(source=.alcor.source, target=.alcor.target)",
            )
        )
        self.assertEqual([p["name"] for p in payloads(lowered)], ["source", "target", "translate"])

    def test_nested_credential_key_is_rejected(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "credential-like field"):
            v3.parse_directives('.alcor.run(model="local", config={client_secret:"hidden"})')

    def test_positional_after_keyword_is_rejected(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "positional"):
            v3.parse_directives('.alcor.run(model="local", "prompt")')

    def test_v2_incompatible_control_escape_is_rejected(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "control character"):
            v3.parse_directives('.alcor.goal("\\b")')

    def test_directive_budget_counts_both_if_arms(self):
        then = ['  .alcor.goal("then")'] * 65
        other = ['  .alcor.goal("else")'] * 65
        src = program("IF true THEN", *then, "ELSE", *other, "END IF")
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "directive limit"):
            v3.transpile(src)

    def test_constant_unroll_counts_actual_effect_attempts(self):
        src = program(
            '.alcor.model("local")',
            "FOR $i FROM 1 TO 128",
            "  .alcor.status()",
            "END FOR",
        )
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "lowers to 129 directive attempts"):
            v3.transpile(src)

    def test_exactly_128_lowered_directive_attempts_pass(self):
        src = program(
            '.alcor.model("local")',
            "FOR $i FROM 1 TO 127",
            "  .alcor.status()",
            "END FOR",
        )
        lowered = v3.transpile(src)
        self.assertEqual(len(payloads(lowered)), 128)

    def test_non_finite_exponent_is_rejected(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "must be finite"):
            v3.parse_directives('.alcor.run(model="local", temperature=1e9999)')

    def test_finite_exponent_is_strict_json(self):
        lowered = v3.transpile(
            program(
                '.alcor.run(model="local", temperature=1e2)',
            )
        )
        self.assertNotIn("Infinity", lowered)
        self.assertNotIn("NaN", lowered)
        self.assertEqual(payloads(lowered)[0]["kwargs"]["temperature"], 100.0)

    def test_thread_has_closed_safe_shape(self):
        for line in (
            '.alcor.thread("safe/thread")',
            '.alcor.thread(id="safe.thread-2")',
        ):
            lowered = v3.transpile(program(line))
            self.assertEqual(payloads(lowered)[0]["name"], "thread")

        invalid = (
            ".alcor.thread()",
            '.alcor.thread(path="../secrets")',
            '.alcor.thread(id="safe", extra="x")',
            '.alcor.thread("safe", id="other")',
            ".alcor.thread(id=7)",
            ".alcor.thread(id=.alcor.goal)",
            '.alcor.thread("/absolute")',
            '.alcor.thread("repo/../secrets")',
        )
        for line in invalid:
            with self.subTest(line=line), self.assertRaises(v3.AlcorLangV3Error):
                v3.transpile(program(line))

    def test_rejected_thread_does_not_bind(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "thread"):
            v3.transpile(
                program(
                    '.alcor.thread(path="../secrets")',
                    ".alcor.memory(source=.alcor.thread)",
                )
            )


class ExpressionTests(unittest.TestCase):
    def test_precedence(self):
        self.assertEqual(v3.compile_expression("2 + 3 * 4"), "ADD 2 MUL 3 4")

    def test_parentheses(self):
        self.assertEqual(v3.compile_expression("(2 + 3) * 4"), "MUL ADD 2 3 4")

    def test_boolean_and_comparison(self):
        self.assertEqual(
            v3.compile_expression("$x >= 10 && !false"),
            "AND GE $x 10 NOT EQ 1 0",
        )

    def test_string_concat_and_function(self):
        self.assertEqual(
            v3.compile_expression('"hello " ++ str($x)'),
            'CAT "hello " STR $x',
        )

    def test_unknown_identifier(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "unknown identifier"):
            v3.compile_expression("something + 1")

    def test_bad_function_arity(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "expects 2 args"):
            v3.compile_expression('cat("a")')

    def test_chained_comparison_rejected_instead_of_miscompiled(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "chained comparisons"):
            v3.compile_expression("1 < $x < 3")

    def test_expression_control_escape_rejected(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "control character"):
            v3.compile_expression('"\\b"')


class StructuredTests(unittest.TestCase):
    def test_assignment_print_input(self):
        lowered = v3.transpile(
            program(
                "INPUT $name",
                '$greeting = "hello " ++ $name',
                "PRINT $greeting",
            )
        )
        self.assertIn("READ $name", lowered)
        self.assertIn('LET $greeting CAT "hello " $name', lowered)
        self.assertIn("EMIT $greeting", lowered)

    def test_if_else_is_forward_control_flow(self):
        lowered = v3.transpile(
            program(
                "$x = 7",
                "IF $x > 3 THEN",
                '  PRINT "big"',
                "ELSE",
                '  PRINT "small"',
                "END IF",
            )
        )
        lines = lowered.splitlines()
        branch = next(line for line in lines if line.startswith("BRANCH GT $x 3"))
        self.assertIn(" ELSE ", branch)
        labels = [line.split()[1] for line in lines if line.startswith("LABEL ")]
        self.assertEqual(len(labels), len(set(labels)))
        self.assertTrue(any(line.startswith("JUMP v3_if_end_") for line in lines))

    def test_branch_binding_is_conservative(self):
        src = program(
            "IF true THEN",
            '  .alcor.model("local")',
            "END IF",
            '.alcor.run(prompt="hello")',
        )
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "requires a prior"):
            v3.transpile(src)

    def test_binding_in_both_branches_survives(self):
        lowered = v3.transpile(
            program(
                "IF true THEN",
                '  .alcor.model("local:a")',
                "ELSE",
                '  .alcor.model("local:b")',
                "END IF",
                '.alcor.run(prompt="hello")',
            )
        )
        self.assertEqual([p["name"] for p in payloads(lowered)], ["model", "model", "run"])

    def test_constant_for_unrolls_in_default_profile(self):
        lowered = v3.transpile(
            program(
                "FOR $i FROM 1 TO 3",
                "  PRINT $i",
                "END FOR",
            )
        )
        self.assertEqual(lowered.count("LET $i "), 4)
        self.assertNotIn("v3_for_test", lowered)
        self.assertNotIn("JUMP", lowered)

    def test_negative_constant_for(self):
        lowered = v3.transpile(
            program(
                "FOR $i FROM 3 TO 1 STEP -1",
                "  PRINT $i",
                "END FOR",
            )
        )
        self.assertIn("LET $i 3", lowered)
        self.assertIn("LET $i 2", lowered)
        self.assertIn("LET $i 1", lowered)

    def test_empty_constant_for(self):
        lowered = v3.transpile(
            program(
                "FOR $i FROM 3 TO 1 STEP 1",
                '  PRINT "never"',
                "END FOR",
            )
        )
        self.assertNotIn("never", lowered)
        self.assertIn("LET $i 3", lowered)

    def test_constant_and_dynamic_for_share_cell_contract(self):
        constant = program(
            "FOR $i FROM 1 TO 3",
            "  $i = 99",
            "  PRINT $i",
            "END FOR",
            "PRINT $i",
        )
        dynamic = program(
            "$last = 3",
            "FOR $i FROM 1 TO $last",
            "  $i = 99",
            "  PRINT $i",
            "END FOR",
            "PRINT $i",
            header="PROGRAM Demo WITH profile=complete authority=conformance",
        )
        expected = "99\n99\n99\n4\n"
        self.assertEqual(v3.run(constant), expected)
        self.assertEqual(v3.run(dynamic), expected)

    def test_constant_and_dynamic_empty_for_initialize_to_start(self):
        constant = program(
            "FOR $i FROM 3 TO 1",
            '  PRINT "never"',
            "END FOR",
            "PRINT $i",
        )
        dynamic = program(
            "$last = 1",
            "FOR $i FROM 3 TO $last",
            '  PRINT "never"',
            "END FOR",
            "PRINT $i",
            header="PROGRAM Demo WITH profile=complete authority=conformance",
        )
        self.assertEqual(v3.run(constant), "3\n")
        self.assertEqual(v3.run(dynamic), "3\n")

    def test_constant_for_limit(self):
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "limit is"):
            v3.transpile(
                program(
                    "FOR $i FROM 0 TO 1000",
                    "  PRINT $i",
                    "END FOR",
                )
            )

    def test_dynamic_for_lowers_to_backward_jump(self):
        lowered = v3.transpile(
            program(
                "$last = 3",
                "FOR $i FROM 1 TO $last",
                "  PRINT $i",
                "END FOR",
                header="PROGRAM Demo WITH profile=complete authority=conformance",
            )
        )
        self.assertIn("LABEL v3_for_test_", lowered)
        self.assertRegex(lowered, r"BRANCH LE \$v3_for_counter_[0-9]+ \$last")
        self.assertRegex(lowered, r"LET \$i \$v3_for_counter_[0-9]+")
        self.assertIn("JUMP v3_for_test_", lowered)

    def test_nested_unroll_renames_labels(self):
        lowered = v3.transpile(
            program(
                "FOR $i FROM 1 TO 2",
                "  IF $i == 1 THEN",
                '    PRINT "one"',
                "  ELSE",
                '    PRINT "two"',
                "  END IF",
                "END FOR",
            )
        )
        labels = [line.split()[1] for line in lowered.splitlines() if line.startswith("LABEL ")]
        self.assertGreaterEqual(len(labels), 6)
        self.assertEqual(len(labels), len(set(labels)))

    def test_comments_outside_strings(self):
        lowered = v3.transpile(
            program(
                "$x = 1 + 2 # arithmetic",
                'PRINT "https://example.com/#frag" // keep URL string',
            )
        )
        self.assertIn("LET $x ADD 1 2", lowered)
        self.assertIn('EMIT "https://example.com/#frag"', lowered)

    def test_multiline_directive(self):
        src = """ALCOR 3
PROGRAM Demo
.alcor.model("local")
.alcor.run(
  prompt="hello",
  tools=["read", "search"],
  stream=true
)
END PROGRAM
"""
        lowered = v3.transpile(src)
        run_payload = payloads(lowered)[1]
        self.assertEqual(run_payload["kwargs"]["tools"], ["read", "search"])
        self.assertIs(run_payload["kwargs"]["stream"], True)

    def test_top_level_directives_auto_wrap(self):
        lowered = v3.transpile('ALCOR 3\n.alcor.model("local")\n.alcor.run(prompt="hi")\n')
        self.assertTrue(lowered.startswith("PROGRAM Program\n"))
        self.assertTrue(lowered.endswith("END PROGRAM\n"))

    def test_multiple_programs(self):
        src = """ALCOR 3
PROGRAM Main
CALL Helper
END PROGRAM
PROGRAM Helper
PRINT "ok"
RETURN 0
END PROGRAM
"""
        lowered = v3.transpile(src)
        self.assertEqual(lowered.count("PROGRAM"), 4)  # two starts + two END PROGRAM
        self.assertIn('EMIT "ok"', lowered)

    def test_v2_passthrough_exact(self):
        src = "PROGRAM Demo\nLET $x ADD 1 2\nEMIT $x\nEND PROGRAM\n"
        self.assertEqual(v3.transpile(src), src)

    def test_unmarked_v3_looking_source_passes_through_exact(self):
        src = 'PROGRAM Demo\r\nPRINT "not selected"\r\n.alcor.run(model="local")\r\nEND PROGRAM\r\n'
        self.assertEqual(v3.transpile(src), src)

    def test_top_level_and_program_mix_rejected(self):
        src = 'ALCOR 3\n.alcor.model("local")\nPROGRAM Demo\nPRINT "x"\nEND PROGRAM\n'
        with self.assertRaisesRegex(v3.AlcorLangV3Error, "mixed"):
            v3.transpile(src)

    def test_shebang_marker(self):
        lowered = v3.transpile('#!ALCOR 3\nPROGRAM Demo\nPRINT "ok"\nEND PROGRAM\n')
        self.assertEqual(lowered, 'PROGRAM Demo\nEMIT "ok"\nEND PROGRAM\n')

    def test_passthrough_does_not_parse_v2_tail_delimiters(self):
        src = 'WRITE Message "x" TO File artifact(unfinished\n'
        self.assertEqual(v3.transpile(src), src)

    def test_late_marker_does_not_select_v3(self):
        src = "PROGRAM Demo\nALCOR 3\nEND PROGRAM\n"
        self.assertEqual(v3.transpile(src), src)

    def test_translate_request_example_transpiles(self):
        request = os.path.join(PROGRAMS, "translate_request.alcor")
        with open(request, encoding="utf-8") as fh:
            lowered = v3.transpile(fh.read())
        self.assertEqual(lowered.count('EMIT CAT "translate_request pass " STR $pass'), 3)
        ps = payloads(lowered)
        self.assertEqual(
            [p["name"] for p in ps],
            [
                "goal",
                "model",
                "thread",
                "context",
                "source",
                "target",
                "translate",
                "compile",
                "status",
            ],
        )
        self.assertEqual(ps[6]["kwargs"]["source"], {"token_ref": "alcor.source"})


class DelegationTests(unittest.TestCase):
    def test_parse_run_and_lower_delegate_only_after_transpile(self):
        fake = types.ModuleType("alcorlang")
        seen = []
        fake.parse = lambda src: seen.append(("parse", src)) or {"type": "module"}
        fake.compile_core = lambda src: seen.append(("core", src)) or {"core": True}
        fake.run = lambda src, input_text="": seen.append(("run", src, input_text)) or "ok\n"
        fake.lower_python = lambda src: seen.append(("py", src)) or "# py\n"
        fake.lower_c = lambda src: seen.append(("c", src)) or "/* c */\n"
        old = v3._RUNTIME
        v3._RUNTIME = fake
        try:
            src = program("$x = 2 + 3", "PRINT $x")
            self.assertEqual(v3.parse(src), {"type": "module"})
            self.assertEqual(v3.compile_core(src), {"core": True})
            self.assertEqual(v3.run(src, "in"), "ok\n")
            self.assertEqual(v3.lower_python(src), "# py\n")
            self.assertEqual(v3.lower_c(src), "/* c */\n")
        finally:
            v3._RUNTIME = old
        self.assertEqual([entry[0] for entry in seen], ["parse", "core", "run", "py", "c"])
        for entry in seen:
            self.assertIn("LET $x ADD 2 3", entry[1])
            self.assertNotIn("ALCOR 3", entry[1])


class CompatibilityTests(unittest.TestCase):
    def test_v3_wrapper_binds_exact_canonical_package(self):
        loaded = v3._runtime()
        package_dir = os.path.dirname(os.path.dirname(os.path.abspath(v3.__file__)))
        self.assertEqual(
            os.path.realpath(loaded.__file__),
            os.path.realpath(os.path.join(package_dir, "__init__.py")),
        )


if __name__ == "__main__":
    unittest.main()
