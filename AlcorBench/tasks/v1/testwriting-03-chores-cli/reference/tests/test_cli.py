import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ChoresCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, "chores.json")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args):
        env = dict(os.environ, HOME=self.tmp.name)
        env.pop("CHORES_FILE", None)
        return subprocess.run([sys.executable, "-m", "chores", "--file", self.data, *args],
                              cwd=ROOT, env=env, capture_output=True, text=True, timeout=20)

    def lines(self, *args):
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def test_empty_list(self):
        self.assertEqual(self.lines("list"), ["nothing to do"])

    def test_add_assigns_increasing_ids(self):
        self.assertEqual(self.lines("add", "Water plants"), ["added #1: Water plants"])
        self.assertEqual(self.lines("add", "Take out bins", "--due", "2026-03-02"),
                         ["added #2: Take out bins"])

    def test_data_persists_between_runs(self):
        self.lines("add", "Descale kettle")
        with open(self.data, encoding="utf-8") as fh:
            saved = json.load(fh)
        self.assertEqual([c["title"] for c in saved], ["Descale kettle"])
        self.assertEqual(self.lines("list"), ["#1 [ ] Descale kettle"])

    def test_list_orders_by_due_date_then_undated(self):
        self.lines("add", "Undated A")
        self.lines("add", "Late", "--due", "2026-05-01")
        self.lines("add", "Early", "--due", "2026-01-15")
        self.lines("add", "Undated B")
        self.lines("add", "Also early", "--due", "2026-01-15")
        self.assertEqual(self.lines("list"), [
            "#3 [ ] Early (due 2026-01-15)",
            "#5 [ ] Also early (due 2026-01-15)",
            "#2 [ ] Late (due 2026-05-01)",
            "#1 [ ] Undated A",
            "#4 [ ] Undated B",
        ])

    def test_done_hides_from_list_but_all_shows_it(self):
        self.lines("add", "Vacuum")
        self.lines("add", "Dust shelves")
        self.assertEqual(self.lines("done", "1"), ["done #1"])
        self.assertEqual(self.lines("list"), ["#2 [ ] Dust shelves"])
        self.assertEqual(self.lines("list", "--all"), ["#1 [x] Vacuum", "#2 [ ] Dust shelves"])

    def test_all_done_says_nothing_to_do(self):
        self.lines("add", "Feed cat")
        self.lines("done", "1")
        self.assertEqual(self.lines("list"), ["nothing to do"])

    def test_done_twice(self):
        self.lines("add", "Mop")
        self.lines("done", "1")
        self.assertEqual(self.lines("done", "1"), ["already done #1"])

    def test_unknown_id(self):
        self.lines("add", "Mop")
        result = self.run_cli("done", "7")
        self.assertEqual(result.returncode, 3)
        self.assertIn("no such chore: 7", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_usage_errors_exit_2(self):
        self.assertEqual(self.run_cli("add", "Bad date", "--due", "2026-13-40").returncode, 2)
        self.assertEqual(self.run_cli("explode").returncode, 2)
        self.assertEqual(self.run_cli("done").returncode, 2)


if __name__ == "__main__":
    unittest.main()
