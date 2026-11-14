"""Acceptance checks for the harness itself: python3 -m alcorbench selfcheck.

Parts: the statistics against hand-computed answers; config resolution and
hashing; the sandbox's isolation guarantees; infrastructure errors, retry
passes, resume and parallel lanes against fake endpoints; validation of every
task (examples and tasks/v1); a scripted end-to-end demo run plus its report.
Exit status 1 on any failure.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import socket
import tempfile
import time
from pathlib import Path

from . import report, stats
from .agents.base import Agent, AgentResult, Budget
from .agents.command import CommandAgent
from .agents.reference import ReferenceAgent
from .agents.base import RunAborted
from .agents.scripted import FakeEndpoint, ScriptedAgent, script_for
from .agents.toolloop import (BATCH_HINT, REMINDER, ToolBox, ToolLoopAgent, ToolLoopConfig,
                              context_packet, detect_test_command)
from .config import (DEFAULT_CONFIG_PATH, DEFAULTS, OPTIONS, ConfigError, config_hash, option,
                     resolve)
from .runner import redact_url, resume_suite, run_suite, run_trial, trial_seed, validate
from .sandbox import PathEscape, new_workdir, resolve_inside
from .tasks import (DEFAULT_TASK_ROOT, EXAMPLE_TASK_ROOT, Task, discover, lint_check_env,
                    stage_workdir)


class Checker:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passed = 0

    def expect(self, ok: bool, what: str) -> None:
        if ok:
            self.passed += 1
        else:
            self.failures.append(what)
            print(f"  FAIL {what}")

    def close(self, a: float, b: float, what: str, tol: float = 1e-4) -> None:
        self.expect(abs(a - b) <= tol, f"{what}: got {a}, expected {b}")


def check_stats(c: Checker) -> None:
    """Known answers, worked by hand or from the closed forms."""
    lo, hi = stats.wilson_interval(5, 10)
    c.close(lo, 0.236593, "wilson(5,10) low")
    c.close(hi, 0.763407, "wilson(5,10) high")
    lo, hi = stats.wilson_interval(0, 10)  # closed form at 0: z^2 / (n + z^2)
    c.close(lo, 0.0, "wilson(0,10) low")
    c.close(hi, stats.Z95**2 / (10 + stats.Z95**2), "wilson(0,10) high")
    c.close(stats.wilson_interval(10, 10)[0], 10 / (10 + stats.Z95**2), "wilson(10,10) low")
    c.expect(stats.wilson_interval(0, 0) == (0.0, 1.0), "wilson with n=0 is (0, 1)")

    c.close(stats.sign_test(9, 1), 22 / 1024, "sign test 9 vs 1")  # 2 * (1 + 10) / 2^10
    c.close(stats.sign_test(5, 0), 2 / 32, "sign test 5 vs 0")
    c.close(stats.sign_test(3, 3), 1.0, "sign test 3 vs 3")
    c.close(stats.sign_test(0, 0), 1.0, "sign test with no untied tasks")
    c.close(stats.sign_test(20, 5), stats.sign_test(5, 20), "sign test is symmetric")

    c.expect(stats.bootstrap_mean_ci([1.0] * 12) == (1.0, 1.0), "bootstrap of a constant")
    half = [0.0] * 50 + [1.0] * 50  # SE of the mean is 0.05, so the CI is about 0.40 to 0.60
    lo, hi = stats.bootstrap_mean_ci(half, seed=7)
    c.expect(0.38 <= lo <= 0.42 and 0.58 <= hi <= 0.62, f"bootstrap 50/50 CI ({lo}, {hi})")
    c.expect(stats.bootstrap_mean_ci(half, seed=7) == (lo, hi), "bootstrap is seeded")

    rows = [{"task_id": t, "trial": k, "passed": p} for t, k, p in [
        ("a", 1, False), ("a", 0, True), ("b", 0, True), ("b", 1, True),
        ("c", 0, False), ("c", 1, False), ("c", 2, True)]]
    c.expect(stats.per_task(rows)["a"] == {0: True, 1: False}, "per_task keys by trial")
    c.close(stats.flip_rate(stats.per_task(rows)), 2 / 3, "flip rate a,c of a,b,c")
    s = stats.summarize(rows)
    c.close(s.mean_pass, (0.5 + 1 + 1 / 3) / 3, "mean of per-task pass fractions")
    c.expect((s.first_try_passes, s.first_try_tasks) == (2, 3), "first-try passes")
    c.expect(stats.flip_rate({"a": {0: True}}) is None, "flip rate needs repeated trials")

    shuffled = list(reversed(rows))
    c.expect(stats.summarize(shuffled) == s and stats.paired_compare(shuffled, rows).ci
             == stats.paired_compare(rows, rows).ci, "row order does not change any statistic")
    c.close(stats.pass_rate_lower_bound(rows, {"a", "b", "c"}, 3), (1 + 2 + 1) / 9,
            "floor counts missing trials as failures")

    infra = [{"task_id": "a", "trial": 2, "passed": False, "infra_error": True},
             {"task_id": "d", "trial": 0, "passed": False, "infra_error": True}]
    s2 = stats.summarize(rows + infra)
    c.expect((s2.n_tasks, s2.n_trials, s2.mean_pass) == (s.n_tasks, s.n_trials, s.mean_pass),
             "infra-error trials are left out of every denominator")
    c.expect(stats.complete_tasks(rows + infra, 3) == {"c"}, "complete_tasks needs every trial")

    same = stats.paired_compare(rows, rows)
    c.expect(same.mean_diff == 0 and same.ci == (0.0, 0.0) and same.p_sign == 1.0,
             "a run compared with itself shows no difference")
    worse = [dict(r, passed=False) for r in rows]
    p = stats.paired_compare(rows, worse)
    c.expect((p.wins, p.losses, p.ties) == (3, 0, 0), "paired wins/losses/ties")
    c.close(p.p_sign, 0.25, "paired sign test 3 vs 0")
    c.close(p.mean_diff, s.mean_pass, "paired mean difference")


class _TamperAgent(Agent):
    """Solves the task, then edits a protected file, directly or when its code is imported."""

    name = "tamper"

    def __init__(self, on_import: bool = False) -> None:
        self.inner = ReferenceAgent()
        self.task: Task | None = None
        self.on_import = on_import

    def prepare(self, task: Task) -> None:
        self.task = task
        self.inner.prepare(task)

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int = 0) -> AgentResult:
        result = self.inner.run(prompt, workdir, budget, transcript_path)
        target = self.task.protected[0]
        if self.on_import:  # every module of the solution rewrites the file when imported
            for rel in self.task.reference_files():
                if rel.endswith(".py"):
                    with open(workdir / rel, "a") as f:
                        f.write(f"\nopen({target!r}, 'w').write('# emptied')\n")
        else:
            (workdir / target).write_text("# emptied\n")
        return result


class _Recorder(Agent):
    """Remembers the work directory it was given."""

    name = "recorder"
    workdir: Path | None = None

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int = 0) -> AgentResult:
        self.workdir = workdir
        return AgentResult()


def _budget(**changes: float) -> Budget:
    return dataclasses.replace(Budget.from_config(), **changes)


def _gone(pid: int, wait_s: float = 3.0) -> bool:
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        try:
            if "zombie" in Path(f"/proc/{pid}/status").read_text():
                return True
        except OSError:  # reaped between the signal and the read
            return True
        time.sleep(0.05)
    return False


def check_sandbox(c: Checker, task: Task) -> None:
    workdir = new_workdir("alcorbench-selfcheck-")
    outside = Path(tempfile.mkdtemp(prefix="alcorbench-outside-"))
    try:
        stage_workdir(task, workdir)
        names = {p.name for p in workdir.rglob("*")}
        c.expect("check.py" not in names and "reference" not in names,
                 "hidden check and reference stay out of the work directory")
        c.expect(task.path not in workdir.resolve().parents, "work directory is outside the task")

        (outside / "secret.txt").write_text("outside")
        (workdir / "link").symlink_to(outside / "secret.txt")
        (workdir / "dirlink").symlink_to(outside)
        for bad in ("../x", "/etc/passwd", "link", "dirlink/secret.txt", "a/../../x"):
            try:
                resolve_inside(workdir, bad)
                c.expect(False, f"path {bad!r} should be refused")
            except PathEscape:
                c.expect(True, "")
        c.expect(resolve_inside(workdir, "a/../b.txt") == workdir.resolve() / "b.txt",
                 "'..' that stays inside is allowed")

        box = ToolBox(workdir, command_timeout_s=1.5, max_output=4000)
        c.expect(box.call("read_file", {"path": "link"}).startswith("error"),
                 "read_file refuses a symlink out of the work directory")
        c.expect(box.call("write_file", {"path": "dirlink/new.txt", "content": "x"})
                 .startswith("error") and not (outside / "new.txt").exists(),
                 "write_file refuses a path through a symlinked directory")
        c.expect(box.call("write_file", {"path": "../escape.txt", "content": "x"})
                 .startswith("error") and not (workdir.parent / "escape.txt").exists(),
                 "write_file refuses '..'")

        os.environ["ALCORBENCH_FAKE_API_KEY"] = "sk-selfcheck-secret"
        try:
            env_out = box.call("run_shell", {"command": "env; pwd"})
        finally:
            del os.environ["ALCORBENCH_FAKE_API_KEY"]
        c.expect("sk-selfcheck-secret" not in env_out, "shell environment is scrubbed")
        c.expect(str(workdir.resolve()) in env_out, "shell runs in the work directory")

        start = time.monotonic()
        out = box.call("run_shell", {"command": "sleep 30 & echo $! > child.pid; wait"})
        c.expect(out.startswith("timed out") and time.monotonic() - start < 10,
                 "shell timeout returns promptly")
        pid = int((workdir / "child.pid").read_text())
        c.expect(_gone(pid), "timeout kills the background child too")

        box.call("run_shell", {"command": "sleep 30 & echo $! > child2.pid"})
        c.expect(_gone(int((workdir / "child2.pid").read_text())),
                 "children left running after a command exits are killed")

        os.environ["ALCORBENCH_FAKE_API_KEY"] = "sk-selfcheck-secret"
        try:
            agent = CommandAgent("test -s {prompt_file}; printenv ALCORBENCH_FAKE_API_KEY > seen.txt; "
                                 "echo '{\"turns\": 2, \"tool_calls\": 5}' > {usage_file}")
            res = agent.run("prompt", workdir, _budget(wall_s=10), outside / "t.txt")
        finally:
            del os.environ["ALCORBENCH_FAKE_API_KEY"]
        c.expect((workdir / "seen.txt").read_text() == "", "command agent env is scrubbed")
        c.expect((res.turns, res.tool_calls) == (2, 5), "command agent reads its usage file")
        res = CommandAgent("cat {prompt_file} >/dev/null; sleep 30").run(
            "p", workdir, _budget(wall_s=1), outside / "t2.txt")
        c.expect(res.status == "timeout" and res.wall_s < 10, "command agent timeout")

        row = run_trial(_TamperAgent(), task, 0, _budget(), outside / "t3.txt", seed=0)
        c.expect(not row["passed"] and row["protected_violation"] == task.protected[:1],
                 "editing a protected file fails the task")
        row = run_trial(_TamperAgent(on_import=True), task, 0, _budget(), outside / "t4.txt", 0)
        c.expect(not row["passed"] and row["protected_violation"] == task.protected[:1],
                 "agent code that rewrites a protected file when the check runs it is caught")

        seen = _Recorder()
        run_trial(seen, task, 0, _budget(), outside / "t5.txt", seed=0)
        c.expect("alcorbench" not in str(seen.workdir).lower() and task.id not in str(seen.workdir),
                 f"the work directory path names neither the harness nor the task: {seen.workdir}")

        os.mkfifo(workdir / "pipe")
        c.expect(box.call("read_file", {"path": "pipe"}).startswith("error")
                 and box.call("write_file", {"path": "pipe", "content": "x"}).startswith("error"),
                 "file tools refuse a FIFO instead of blocking on it")

        bad_checks = {
            "the task-dir variable": 'import os\nos.environ["ALCORBENCH_TASK_DIR"]\n',
            "an inherited environment": 'import subprocess\nsubprocess.run(["x"])\n',
            "dict(os.environ)": 'import os, subprocess\nsubprocess.run(["x"], env=dict(os.environ))\n',
            "a filtered copy": ('import os, subprocess\nE = {k: v for k, v in os.environ.items()}\n'
                                'subprocess.run(["x"], env=E)\n'),
        }
        for what, source in bad_checks.items():
            c.expect(bool(lint_check_env(source)), f"validate rejects a check using {what}")
        good = ('import os, subprocess\nE = {"PATH": os.environ.get("PATH", "/bin")}\n'
                'subprocess.run(["x"], env=E)\n')
        c.expect(lint_check_env(good) == [], "validate accepts an explicit minimal environment")
    finally:
        shutil.rmtree(workdir.parent, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


def check_config(c: Checker) -> None:
    """One default source, file then flags precedence, and an order-free hash."""
    shipped = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    c.expect(ToolLoopConfig().agent_config["system_prompt"] == shipped["system_prompt"],
             "the agent's default prompt comes from configs/default.json")
    c.expect(config_hash({"a": 1, "b": {"x": 1, "y": [2, 3]}})
             == config_hash({"b": {"y": [2, 3], "x": 1}, "a": 1}), "hash ignores key order")
    c.expect(config_hash({"a": 1}) != config_hash({"a": 2}), "hash sees a changed value")
    tmp = Path(tempfile.mkdtemp(prefix="alcorbench-config-"))
    try:
        reversed_defaults = dict(reversed(list(DEFAULTS.items())))
        (tmp / "same.json").write_text(json.dumps(reversed_defaults, indent=4))
        c.expect(config_hash(resolve(tmp / "same.json")) == config_hash(DEFAULTS),
                 "a file restating the defaults in another order has the default hash")
        (tmp / "prompt.txt").write_text("Be brief.")
        (tmp / "mine.json").write_text(json.dumps(
            {"system_prompt_file": "prompt.txt", "temperature": 0.7, "max_turns": 5}))
        mine = resolve(tmp / "mine.json", {"temperature": 0.2, "max_tool_calls": None})
        c.expect((mine["system_prompt"], mine["temperature"], mine["max_turns"],
                  mine["max_tool_calls"]) == ("Be brief.", 0.2, 5, DEFAULTS["max_tool_calls"]),
                 "prompt file is read; flags override the file; unset flags do not")
        from .cli import agent_config, agents_from_args, build_parser  # cli imports this module
        args = build_parser().parse_args(
            ["run", "--agent", "toolloop", "--model", "lane-a, lane-b",
             "--config", str(tmp / "mine.json"), "--temperature", "0.2"])
        resolved = agent_config(args)
        agents = agents_from_args(args, resolved)
        c.expect(resolved["temperature"] == 0.2 and resolved["max_turns"] == 5,
                 "on the command line, flags override the config file")
        c.expect([a.lane for a in agents] == ["lane-a", "lane-b"]
                 and all(a.config.agent_config == resolved for a in agents),
                 "--model a,b gives one agent per lane, all with the resolved config")
        try:
            agents_from_args(build_parser().parse_args(
                ["run", "--agent", "toolloop", "--model", "x,x"]), resolved)
            c.expect(False, "a repeated lane should be refused")
        except SystemExit:
            c.expect(True, "")
        try:
            resolve(None, {"extra_body": {"model": "other"}})
            c.expect(False, "extra_body must not override the model")
        except ConfigError:
            c.expect(True, "")
        (tmp / "bad.json").write_text(json.dumps({"temprature": 1}))
        try:
            resolve(tmp / "bad.json")
            c.expect(False, "an unknown config key should be refused")
        except ConfigError:
            c.expect(True, "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# configs/default.json as hashed by the train baseline (results/2026-11-13-baseline-train).
BASELINE_CONFIG_SHA256 = "57117e8087bd4288d9431b8126a4063ae773a15f12416cb047771fe103ab9b08"


def check_option_config(c: Checker) -> None:
    """The tool-loop options are off by default and invisible to the hash until used."""
    c.expect(config_hash(DEFAULTS) == BASELINE_CONFIG_SHA256 and not set(OPTIONS) & set(DEFAULTS),
             "the default config has no option keys and hashes as the baseline did")
    tmp = Path(tempfile.mkdtemp(prefix="alcorbench-options-"))
    try:
        (tmp / "off.json").write_text(json.dumps(dict(OPTIONS)))
        c.expect(resolve(tmp / "off.json") == DEFAULTS,
                 "options stated at their off values resolve and hash as the default")
        for bad in ({"prefetch": "yes"}, {"prefetch_bytes": "big"}, {"test_command": ""},
                    {"finish_gate_repairs": True}):
            try:
                resolve(None, bad)
                c.expect(False, f"option value {bad} should be refused")
            except ConfigError:
                c.expect(True, "")
        on = resolve(None, {"prefetch": True, "finish_gate_repairs": 1})
        c.expect(on["prefetch"] is True and on["finish_gate_repairs"] == 1
                 and config_hash(on) != config_hash(DEFAULTS) and option(on, "auto_test") is False,
                 "an option that is used is recorded and changes the hash")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _tool_replies(transcript: Path) -> list[str]:
    rows = [json.loads(ln) for ln in transcript.read_text().splitlines()]
    return [r["content"] for r in rows if r.get("role") == "tool"]


def _paired(transcript: Path) -> bool:
    """Every tool call the model sent has exactly one reply, in order, before the next turn."""
    rows = [json.loads(ln) for ln in transcript.read_text().splitlines()]
    pending: list[str] = []
    for r in rows:
        if r.get("role") == "assistant":
            if pending:
                return False
            pending = [call["id"] for call in r.get("tool_calls") or []]
        elif r.get("role") == "tool":
            if not pending or pending.pop(0) != r["tool_call_id"]:
                return False
    return True


def _system(transcript: Path) -> str:
    return json.loads(transcript.read_text().splitlines()[0])["content"]


def check_options(c: Checker, task: Task) -> None:
    """prefetch, auto_test, finish_gate, batch_hint and several calls in one message."""
    tmp = Path(tempfile.mkdtemp(prefix="alcorbench-opts-"))
    workdir = new_workdir("alcorbench-selfcheck-")
    try:
        stage_workdir(task, workdir)
        (tmp / "secret.txt").write_text("OUTSIDE-SECRET")
        (workdir / "leak.txt").symlink_to(tmp / "secret.txt")
        (workdir / "leakdir").symlink_to(tmp)
        cmd = detect_test_command(workdir)
        c.expect(cmd == "python3 -m unittest discover -s tests -t .",
                 f"test command detected from tests/: {cmd}")
        packet = context_packet(workdir, task.brief, 12_000, cmd)
        fixture = (task.path / "fixture" / "numstat" / "center.py").read_text()
        tests = (task.path / "fixture" / "tests" / "test_center.py").read_text()
        hidden = [(task.path / "check.py").read_text(),
                  *(d.decode() for d in task.reference_files().values())]
        c.expect(fixture in packet and tests in packet and f"Test command: {cmd}" in packet
                 and "numstat/center.py (" in packet and "truncated" not in packet,
                 "packet holds the tree, the named file, the small test file and the test command")
        c.expect("OUTSIDE-SECRET" not in packet and "leak" not in packet
                 and not any(h.strip() in packet for h in hidden),
                 "packet holds nothing from outside the work directory, the check or the reference")
        c.expect(len(packet.encode()) <= 12_000, "packet within its byte budget")
        cut = context_packet(workdir, task.brief, 600, cmd)
        c.expect(len(cut.encode()) <= 600 and cut.rstrip().endswith("read_file for the rest]")
                 and "--- numstat/center.py ---" in cut and fixture not in cut,
                 "packet cuts a file at its byte budget and says it was truncated")
        bare = tmp / "bare"
        bare.mkdir()
        (bare / "app.py").write_text("x = 1\n")
        c.expect(detect_test_command(bare) is None and detect_test_command(bare, "make t") == "make t"
                 and "Test command: none detected" in context_packet(bare, "", 12_000, None),
                 "no test files: no test command unless one is configured")
        many = tmp / "many"
        for i in range(300):
            (many / "pkg").mkdir(parents=True, exist_ok=True)
            (many / "pkg" / f"module_{i:03d}.py").write_text("")
        tree = context_packet(many, "", 2_000, "make t")
        c.expect(len(tree.encode()) <= 2_000 and "Test command: make t" in tree
                 and "more files; list_files" in tree, "a long file tree is cut with a marker")

        def trial(name: str, steps: list | None, **opts: object) -> tuple[dict, Path, FakeEndpoint]:
            transcript = tmp / f"{name}.jsonl"
            with FakeEndpoint([task], busy=()) as fake:
                if steps is not None:
                    fake.scripts[task.brief] = steps
                row = run_trial(_lane(fake, "m", agent_config=resolve(None, opts)), task, 0,
                                _budget(), transcript, seed=1)
            return row, transcript, fake

        row, t, fake = trial("prefetch", None, prefetch=True)
        first = fake.first_messages[0]
        c.expect(row["passed"] and first.startswith(task.brief + "\n\nContext packet")
                 and fixture in first and len(first.encode()) <= len(task.brief.encode()) + 2 + 12_000,
                 "with prefetch the first user message is the brief followed by the packet")
        row, t, fake = trial("plain", None)
        c.expect(row["passed"] and _system(t) == DEFAULTS["system_prompt"]
                 and set(fake.first_messages) == {task.brief}
                 and row["auto_tests"] == 0 and row["finish_gate_rejections"] == 0
                 and not any("auto-test" in r for r in _tool_replies(t)),
                 "with every option off the loop behaves as before")

        row, t, _ = trial("autotest", None, auto_test=True)
        writes = [r for r in _tool_replies(t) if r.startswith("wrote ")]
        c.expect(row["passed"] and row["auto_tests"] == 1 and row["auto_test_s"] > 0
                 and writes and "auto-test: tests pass" in writes[0]
                 and row["tool_calls"] == len(script_for(task)),
                 "auto_test appends a passing result to the edit, within the same tool call")
        broken = ("write_file", {"path": "numstat/center.py", "content": "def median(:\n"})
        row, t, _ = trial("autofail", [[broken], [("finish", {"summary": "x"})]], auto_test=True)
        reply = _tool_replies(t)[0]
        c.expect(row["auto_tests"] == 1 and "auto-test: tests FAIL" in reply
                 and "SyntaxError" in reply and "exit code" in reply,
                 "auto_test appends the failure tail after a breaking edit")
        fin = [("finish", {"summary": "done"})]
        miss = ("replace_in_file", {"path": "numstat/center.py", "old": "absent", "new": "x"})
        row, t, _ = trial("autoskip", [[miss], fin],
                          auto_test=True, test_command="echo custom; exit 3")
        c.expect(row["auto_tests"] == 0 and "auto-test" not in _tool_replies(t)[0],
                 "auto_test does not run after a failed edit")
        row, t, _ = trial("custom", [[broken], fin], auto_test=True,
                          test_command="echo custom; exit 3")
        c.expect("exit code 3" in _tool_replies(t)[0] and "custom" in _tool_replies(t)[0],
                 "a configured test_command is the one that runs")
        with FakeEndpoint([task], busy=()) as fake:
            fake.scripts[task.brief] = [[("write_file", {"path": "app.py", "content": "x"})], fin]
            agent = _lane(fake, "m", agent_config=resolve(None, {"auto_test": True,
                                                                  "finish_gate": True}))
            res = agent.run(task.brief, bare, _budget(), tmp / "none.jsonl", 1)
        c.expect(res.status == "finished" and res.auto_tests == 0
                 and res.finish_gate_rejections == 0 and res.turns == 2,
                 "auto_test and finish_gate do nothing when there is no test command")

        late = ("write_file", {"path": "late.txt", "content": "x"})
        row, t, _ = trial("gate", [[broken], fin + [late], fin, fin, fin],
                          finish_gate=True)
        replies = _tool_replies(t)
        c.expect(row["status"] == "finished" and row["finish_gate_rejections"] == 2
                 and row["turns"] == 4 and replies[1].startswith("not finished: tests fail")
                 and replies[2].startswith("not run") and replies[-1] == "finished"
                 and sum(r.startswith("not finished") for r in replies) == 2
                 and row["tool_counts"] == {"write_file": 1, "finish": 3} and _paired(t),
                 "finish_gate refuses finish twice while tests fail, then accepts it")
        row, t, _ = trial("gatepass", None, finish_gate=True)
        c.expect(row["passed"] and row["status"] == "finished"
                 and row["finish_gate_rejections"] == 0, "finish_gate accepts when tests pass")

        batch = [[("write_file", {"path": "a.txt", "content": "one"}),
                  ("run_shell", {"command": "cat a.txt; echo two >> a.txt"}),
                  ("read_file", {"path": "a.txt"})], fin]
        row, t, _ = trial("batch", batch, batch_hint=True)
        replies = _tool_replies(t)
        c.expect(row["turns"] == 2 and row["tool_calls"] == 4 and "one" in replies[1]
                 and replies[2] == "onetwo\n" and row["final_prompt_tokens"] > 0
                 and row["tool_counts"] == {"write_file": 1, "run_shell": 1, "read_file": 1,
                                            "finish": 1} and _paired(t),
                 "several tool calls in one message run in order and are counted by name")
        c.expect(_system(t) == DEFAULTS["system_prompt"] + BATCH_HINT,
                 "batch_hint adds its sentence to the system prompt")
    finally:
        shutil.rmtree(workdir.parent, ignore_errors=True)
        shutil.rmtree(tmp, ignore_errors=True)


class _Interrupt(Agent):
    """Wraps an agent and raises KeyboardInterrupt on call number `at`, like Ctrl-C."""

    def __init__(self, inner: Agent, at: int) -> None:
        self.inner, self.at, self.calls = inner, at, 0
        self.name = inner.name

    def prepare(self, task: Task) -> None:
        self.inner.prepare(task)

    def run(self, prompt: str, workdir: Path, budget: Budget, transcript_path: Path,
            seed: int = 0) -> AgentResult:
        self.calls += 1
        if self.calls == self.at:
            raise KeyboardInterrupt
        return self.inner.run(prompt, workdir, budget, transcript_path, seed)


def _lane(fake: FakeEndpoint | str, model: str, timeout_s: float = 300.0,
          agent_config: dict = DEFAULTS) -> ToolLoopAgent:
    url = fake if isinstance(fake, str) else fake.base_url
    return ToolLoopAgent(ToolLoopConfig(base_url=url, model=model, api_key_env="",
                                        retries=0, request_timeout_s=timeout_s,
                                        agent_config=agent_config))


def _closed_port_url() -> str:
    """A local URL nothing listens on, so connections are refused."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}/v1"


def check_runs(c: Checker, tasks: list[Task]) -> None:
    """Outages, retry passes, the infra boundary, resume and lanes, all on fake endpoints."""
    tmp = Path(tempfile.mkdtemp(prefix="alcorbench-runs-"))
    quiet = dict(config=DEFAULTS, seed=0, split="train", demo=True, progress=False)
    ids = sorted(t.id for t in tasks)
    try:
        # A lane that is busy for the first two requests, then recovers. With no
        # client retries both first attempts are infra errors; one extra pass fixes them.
        with FakeEndpoint(tasks, busy=range(1, 3)) as fake:
            m = run_suite([_lane(fake, "m")], tasks, trials=1, out_dir=tmp / "recover",
                          infra_passes=2, infra_backoff_s=0, **quiet)
        raw = report.load_rows(tmp / "recover")
        _, rows = report.load_run(tmp / "recover")
        c.expect(sum(r["infra_error"] for r in raw) == 2 and all(r["passed"] for r in rows)
                 and m["complete"] and m["unresolved_infra"] == 0,
                 "infra errors are retried in an extra pass and the run completes")
        c.expect(all(r["check_returncode"] is None for r in raw if r["infra_error"]),
                 "an infra-failed trial is not checked or graded")

        # Busy for three requests with one extra pass: the first task stays unresolved.
        with FakeEndpoint(tasks, busy=range(1, 4)) as fake:
            m = run_suite([_lane(fake, "m")], tasks, trials=1, out_dir=tmp / "outage",
                          infra_passes=1, infra_backoff_s=0, **quiet)
        man, rows = report.load_run(tmp / "outage")
        text = report.render(man, rows)
        c.expect(not m["complete"] and m["unresolved_infra"] == 1,
                 "an unresolved infra error marks the manifest incomplete")
        c.expect("INCOMPLETE" in text and "| all | 1 | 100.0%" in text,
                 "the report excludes the infra-failed task from the pass rate and says so")
        cmp = report.render_compare(report.load_run(tmp / "recover"), (man, rows), ("a", "b"))
        c.expect("1 shared task(s) dropped" in cmp and "Paired tasks: 1" in cmp,
                 "compare pairs only tasks complete in both runs and says how many it dropped")

        # Resume against a healthy endpoint re-runs only the unresolved trial.
        before = report.load_rows(tmp / "outage")
        with FakeEndpoint(tasks, busy=()) as fake:
            m = resume_suite([_lane(fake, "m")], tasks, tmp / "outage", progress=False)
        after = report.load_rows(tmp / "outage")
        c.expect(after[:len(before)] == before and len(after) == len(before) + 1
                 and m["complete"], "resume re-runs only the infra-failed trial")

        # Each way an endpoint can fail before any model output is an infra error.
        task = tasks[0]
        outages = {
            "429 busy": (dict(busy=range(1, 99), busy_reply=(429, {"error": "busy"})), 300),
            "502 bad gateway": (dict(busy=range(1, 99), busy_reply=(502, {"error": "x"})), 300),
            "a first request with no reply bytes before the timeout":
                (dict(busy=(), delay_s=1.0), 0.3),
        }
        for what, (kwargs, timeout_s) in outages.items():
            with FakeEndpoint([task], **kwargs) as fake:
                row = run_trial(_lane(fake, "m", timeout_s), task, 0, _budget(),
                                tmp / "o.jsonl", seed=1)
            c.expect(row["infra_error"] and row["turns"] == 0
                     and row["check_returncode"] is None, f"{what} is an infra error")
        row = run_trial(_lane(_closed_port_url(), "m"), task, 0, _budget(), tmp / "o.jsonl", 1)
        c.expect(row["infra_error"] and row["check_returncode"] is None,
                 "a refused connection is an infra error")

        # Everything else on the first request is graded, or aborts the run for a 4xx.
        graded = {
            "a 500": (dict(busy=range(1, 99), busy_reply=(500, {"error": "x"})), 300),
            "a 200 with an error body": (dict(busy=range(1, 99), busy_reply=(200, {"e": 1})), 300),
            "a reply that starts and then overruns": (dict(busy=(), stall_s=1.0), 0.3),
        }
        for what, (kwargs, timeout_s) in graded.items():
            with FakeEndpoint([task], **kwargs) as fake:
                row = run_trial(_lane(fake, "m", timeout_s), task, 0, _budget(),
                                tmp / "o.jsonl", seed=1)
            c.expect(row["status"] == "error" and not row["infra_error"]
                     and row["check_returncode"] is not None and row["error"],
                     f"{what} on the first request is graded as a failure, error recorded")
        with FakeEndpoint([task], busy=range(1, 99), busy_reply=(404, {"error": "no model"})) as f:
            try:
                run_suite([_lane(f, "m")], [task], trials=1, out_dir=tmp / "abort", **quiet)
                c.expect(False, "a 4xx on the first request should abort the run")
            except RunAborted as exc:
                c.expect("--model" in str(exc) and f.requests == 1,
                         "a 4xx on the first request aborts the run at once, with a clear message")

        # The wall-time limit holds inside a turn: a slow reply is cut at the deadline.
        start = time.monotonic()
        with FakeEndpoint([task], busy=(), delay_s=3.0) as fake:
            row = run_trial(_lane(fake, "m"), task, 0, _budget(wall_s=0.5), tmp / "o.jsonl", 1)
        c.expect(time.monotonic() - start < 2.5, "the request timeout never exceeds the time left")

        # Text with no tool call gets one reminder; only finish ends a trial as finished.
        with FakeEndpoint([task], busy=()) as fake:
            fake.scripts[task.brief] = [[], []]
            row = run_trial(_lane(fake, "m"), task, 0, _budget(), tmp / "text.jsonl", 1)
        reminded = any(json.loads(ln).get("content") == REMINDER
                       for ln in (tmp / "text.jsonl").read_text().splitlines())
        c.expect(row["status"] == "error" and row["turns"] == 2 and reminded,
                 "two text-only replies: one reminder, then the trial ends unfinished")
        with FakeEndpoint([task], busy=()) as fake:
            steps = script_for(task)
            fake.scripts[task.brief] = [[]] + steps
            row = run_trial(_lane(fake, "m"), task, 0, _budget(), tmp / "o.jsonl", 1)
        c.expect(row["status"] == "finished" and row["passed"],
                 "after the reminder the model can carry on and finish")

        # Calls after finish in the same message are not run.
        with FakeEndpoint([task], busy=()) as fake:
            fake.scripts[task.brief] = steps[:-1] + [[("finish", {"summary": "x"}),
                                                      ("write_file", {"path": "late.txt",
                                                                      "content": "x"})]]
            row = run_trial(_lane(fake, "m"), task, 0, _budget(), tmp / "o.jsonl", 1)
        c.expect(row["status"] == "finished" and row["tool_calls"] == len(steps),
                 "tool calls after finish in the same message are not executed")

        # A failure after the model has produced a turn is graded, not an infra error.
        with FakeEndpoint(tasks[:1], busy=range(2, 10_000)) as fake:
            row = run_trial(_lane(fake, "m"), tasks[0], 0, _budget(), tmp / "mid.jsonl", seed=1)
        c.expect(row["status"] == "error" and row["turns"] == 1 and not row["infra_error"]
                 and row["check_returncode"] is not None,
                 "an endpoint failure after the first turn is a real, graded failure")

        # Ctrl-C after two trials, then resume: finished rows are kept, the rest filled in.
        try:
            run_suite([_Interrupt(ScriptedAgent(), at=3)], tasks, trials=2,
                      out_dir=tmp / "stopped", **quiet)
            c.expect(False, "the interrupt should propagate")
        except KeyboardInterrupt:
            pass
        before = report.load_rows(tmp / "stopped")
        man = json.loads((tmp / "stopped" / "manifest.json").read_text())
        c.expect(len(before) == 2 and man["finished"] is None,
                 "an interrupted run keeps its finished rows and is marked unfinished")
        counter = _Interrupt(ScriptedAgent(), at=0)
        m = resume_suite([counter], tasks, tmp / "stopped", progress=False)
        after = report.load_rows(tmp / "stopped")
        c.expect(counter.calls == 2 and after[:2] == before and m["complete"]
                 and len(report.latest_rows(after)) == 2 * len(tasks),
                 "resume fills the missing trials without re-running finished ones")

        # Two lanes, two endpoints: each request goes to its own lane, both lanes work,
        # and seeds depend on (task, trial) only.
        with FakeEndpoint(tasks, busy=(), delay_s=0.05) as fa, \
                FakeEndpoint(tasks, busy=(), delay_s=0.05) as fb:
            m = run_suite([_lane(fa, "lane-a"), _lane(fb, "lane-b")], tasks, trials=2,
                          out_dir=tmp / "lanes", **quiet)
        _, rows = report.load_run(tmp / "lanes")
        want = {trial_seed(0, t, k) for t in ids for k in range(2)}
        c.expect(m["complete"] and all(r["passed"] for r in rows), "two-lane run passes")
        c.expect(m["config"] == DEFAULTS and m["config_sha256"] == config_hash(DEFAULTS)
                 and m["lanes"] == ["lane-a", "lane-b"],
                 "the manifest records lanes, the resolved config and its hash")
        c.expect(m["agent_options"]["base_url"] == f"http://local:{fa.server.server_address[1]}"
                 and redact_url("https://gpu-box.internal:8443/v1") == "https://redacted:8443",
                 "the manifest keeps only scheme and port of the endpoint")
        mixed = dict(m, models_reported=["model-x", "model-y"])
        c.expect(any("MIXED MODELS" in x for x in report.labels(mixed, rows)),
                 "a run whose endpoint reported two model names is labelled MIXED MODELS")
        try:
            report.render_compare((mixed, rows), (m, rows), ("a", "b"))
            c.expect(False, "compare should refuse a mixed-model run")
        except ValueError:
            c.expect(True, "")
        c.expect(fa.models == {"lane-a"} and fb.models == {"lane-b"},
                 "each worker stays on its own lane, and both lanes did work")
        c.expect({r["lane"] for r in rows} == {"lane-a", "lane-b"}
                 and all(r["seed"] == trial_seed(0, r["task_id"], r["trial"]) for r in rows)
                 and fa.seeds | fb.seeds == want,
                 "rows record the lane; seeds are the same whichever lane ran a trial")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_tasks(c: Checker, tasks: list[Task]) -> list[Task]:
    """Validate every task; return the valid ones for the demo."""
    problems = validate(tasks)
    for task_id, issues in problems.items():
        for issue in issues:
            c.expect(False, f"validate {task_id}: {issue}")
        if not issues:
            c.expect(True, "")
    return [t for t in tasks if not problems[t.id]]


def check_demo(c: Checker, tasks: list[Task]) -> None:
    out = Path(tempfile.mkdtemp(prefix="alcorbench-demo-"))
    try:
        run_suite([ScriptedAgent()], tasks, trials=1, config=DEFAULTS, out_dir=out, seed=0,
                  split="all", demo=True, progress=False)
        manifest, rows = report.load_run(out)
        failed = [r["task_id"] + ": " + (r["error"] or r["check_output_tail"].strip()[-200:])
                  for r in rows if not r["passed"]]
        c.expect(not failed, f"scripted demo fails on {failed}")
        c.expect(all(r["status"] == "finished" and r["tool_calls"] >= 3 for r in rows),
                 "scripted demo ran the tool loop to finish on every task")
        c.expect(manifest["models_reported"] == ["scripted-demo"], "demo model id is recorded")
        text = report.render(manifest, rows)
        c.expect("DEMO" in text and "| all |" in text, "report renders with the demo label")
    finally:
        shutil.rmtree(out, ignore_errors=True)


def main() -> int:
    c = Checker()
    examples = discover([EXAMPLE_TASK_ROOT])
    if not examples:
        print("FAIL no example tasks found")
        return 1
    tasks = discover([EXAMPLE_TASK_ROOT, DEFAULT_TASK_ROOT])
    valid: list[Task] = []
    sections = [
        ("statistics", lambda: check_stats(c)),
        ("config", lambda: check_config(c)),
        ("sandbox", lambda: check_sandbox(c, examples[0])),
        ("tool-loop options", lambda: (check_option_config(c), check_options(c, examples[0]))),
        ("infra errors, retry passes, resume and lanes", lambda: check_runs(c, examples)),
        (f"task validation ({len(tasks)} tasks)", lambda: valid.extend(check_tasks(c, tasks))),
        ("scripted end-to-end demo on the valid tasks", lambda: check_demo(c, valid)),
    ]
    for title, run in sections:
        before = len(c.failures)
        print(f"[{title}]")
        try:
            run()
        except Exception as exc:  # a crash is a failure of this section, not of selfcheck
            c.expect(False, f"{title} crashed: {type(exc).__name__}: {exc}")
        print(f"  {'ok' if len(c.failures) == before else 'FAILED'}")
    print(f"selfcheck: {c.passed} checks passed, {len(c.failures)} failed")
    return 1 if c.failures else 0
