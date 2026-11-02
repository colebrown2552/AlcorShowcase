from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from alcorlang.cli import main as cli_main

import alcorlang as language
from alcorlang import lint as alcorlint


class AlcorLintTests(unittest.TestCase):
    def rules(self, report):
        return [item["rule"] for item in report["diagnostics"]]

    def test_clean_default_program(self):
        report = alcorlint.lint_source('PROGRAM\nEMIT "ok"\nEND PROGRAM\n', language=language)
        self.assertTrue(report["ok"])
        self.assertTrue(report["clean"])
        self.assertEqual(report["schema"], "alcor.lint.v1")

    def test_parse_error_is_normalized_with_location(self):
        report = alcorlint.lint_source(
            'PROGRAM Broken\nEMIT CAT "x"\nEND PROGRAM\n', path="broken.alcor", language=language
        )
        self.assertFalse(report["ok"])
        d = next(item for item in report["diagnostics"] if item["rule"] == "parse/error")
        self.assertEqual(d["severity"], "error")
        self.assertEqual(d["path"], "broken.alcor")
        self.assertGreaterEqual(d["line"], 2)

    def test_warnings_do_not_make_valid_source_not_ok(self):
        report = alcorlint.lint_source(
            "PROGRAM Spin WITH profile=complete\nEMIT 1\nEND PROGRAM\n", language=language
        )
        self.assertTrue(report["ok"])
        self.assertFalse(report["clean"])
        self.assertIn("profile/unsigned-complete", self.rules(report))

    def test_complete_sandbox_and_unbounded_warnings(self):
        report = alcorlint.lint_source(
            "PROGRAM Spin WITH profile=complete authority=conformance fuel=0\n"
            "LABEL top\nJUMP top\nEND PROGRAM\n",
            language=language,
        )
        self.assertIn("profile/conformance-authority", self.rules(report))
        self.assertIn("profile/unbounded-fuel", self.rules(report))

    def test_effect_inside_loop_is_visible(self):
        report = alcorlint.lint_source(
            "PROGRAM Spin WITH profile=complete authority=conformance fuel=10\n"
            'LOOP WHILE 1\nWRITE Message "x"\nEND LOOP\nEND PROGRAM\n',
            language=language,
        )
        d = next(item for item in report["diagnostics"] if item["rule"] == "effect/in-loop")
        self.assertEqual(d["line"], 3)

    def test_unreachable_direct_program_from_unnamed_entry(self):
        report = alcorlint.lint_source(
            'PROGRAM\nEMIT "entry"\nEND PROGRAM\nPROGRAM Dead\nRETURN 0\nEND PROGRAM\n',
            language=language,
        )
        d = next(
            item for item in report["diagnostics"] if item["rule"] == "flow/unreachable-program"
        )
        self.assertEqual(d["data"]["program"], "Dead")

    def test_named_first_block_is_not_assumed_library_entry(self):
        report = alcorlint.lint_source(
            "PROGRAM ExportA\nRETURN 1\nEND PROGRAM\nPROGRAM ExportB\nRETURN 2\nEND PROGRAM\n",
            language=language,
        )
        self.assertNotIn("flow/unreachable-program", self.rules(report))

    def test_role_warning_tracks_active_table_contract(self):
        report = alcorlint.lint_source('WRITE Message "x"\n', language=language)
        skipped = str(language.table().get("role_check", "")).startswith("skipped")
        self.assertEqual("vocabulary/role-check-skipped" in self.rules(report), skipped)

    def test_source_hygiene_rules_and_family_disable(self):
        source = 'PROGRAM\n\tEMIT "x"  \nEND PROGRAM'
        report = alcorlint.lint_source(source, language=language)
        self.assertIn("source/tab-indentation", self.rules(report))
        self.assertIn("source/trailing-whitespace", self.rules(report))
        self.assertIn("source/missing-final-newline", self.rules(report))
        disabled = alcorlint.lint_source(source, disabled_rules=("source/*",), language=language)
        self.assertFalse(any(rule.startswith("source/") for rule in self.rules(disabled)))

    def test_audit_enumerates_missing_includes(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "host.alcor").write_text(
                'PROGRAM\nEND PROGRAM\nINCLUDE "missing.alcor"\n', encoding="utf-8"
            )
            report = alcorlint.audit(root, language=language)
        self.assertIn("project/missing-include", self.rules(report))

    def test_audit_detects_case_colliding_paths_when_supported(self):
        with tempfile.TemporaryDirectory() as root:
            upper = Path(root, "A.alcor")
            lower = Path(root, "a.alcor")
            upper.write_text("PROGRAM\nEND PROGRAM\n", encoding="utf-8")
            lower.write_text('PROGRAM\nEMIT "x"\nEND PROGRAM\n', encoding="utf-8")
            if os.path.samefile(upper, lower):
                self.skipTest("filesystem is case-insensitive")
            report = alcorlint.audit(root, language=language)
        self.assertEqual(
            len([d for d in report["diagnostics"] if d["rule"] == "project/case-collision"]), 2
        )

    def test_semicolon_and_quoted_semicolon_effect_location(self):
        report = alcorlint.lint_source(
            "PROGRAM Spin WITH profile=complete authority=conformance fuel=10; LOOP WHILE 1; "
            'WRITE Message "a;b"; END LOOP; END PROGRAM;\n',
            language=language,
        )
        effects = [d for d in report["diagnostics"] if d["rule"] == "effect/in-loop"]
        self.assertEqual(len(effects), 1)
        self.assertEqual(effects[0]["line"], 1)

    def test_existing_sibling_include_is_not_missing(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "lib.alcor").write_text(
                "PROGRAM Lib\nRETURN 1\nEND PROGRAM\n", encoding="utf-8"
            )
            host = Path(root, "host.alcor")
            host.write_text(
                'PROGRAM\nCALL Lib INTO $value\nEND PROGRAM\nINCLUDE "lib.alcor"\n',
                encoding="utf-8",
            )
            report = alcorlint.audit(str(host), language=language)
        self.assertNotIn("project/missing-include", self.rules(report))

    def test_audit_refuses_alcor_symlink_escape(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            target = Path(outside, "outside.alcor")
            target.write_text('PROGRAM\nEMIT "private"\nEND PROGRAM\n', encoding="utf-8")
            link = Path(root, "escape.alcor")
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            report = alcorlint.audit(root, language=language)
        self.assertIn("project/path-escape", self.rules(report))

    def test_cli_json_and_strict(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, "unsigned.alcor")
            path.write_text(
                "PROGRAM Spin WITH profile=complete\nEMIT 1\nEND PROGRAM\n", encoding="utf-8"
            )
            normal = io.StringIO()
            strict = io.StringIO()
            with contextlib.redirect_stdout(normal):
                code = cli_main(["lint", str(path), "--format", "json"])
            with contextlib.redirect_stdout(strict):
                strict_code = cli_main(["lint", str(path), "--format", "json", "--strict"])
        self.assertEqual(code, 0)
        self.assertEqual(strict_code, 1)
        self.assertEqual(json.loads(normal.getvalue())["schema"], "alcor.lint.v1")


if __name__ == "__main__":
    unittest.main()
