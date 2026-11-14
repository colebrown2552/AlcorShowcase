"""Validate tasks and run agents over them, writing manifest.json and trials.jsonl.

trials.jsonl is append-only: a retried trial adds a row and the latest row for
a (task, trial) pair is the one that counts. Rows are never rewritten, so the
record of an outage survives its retry.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import platform
import queue
import shutil
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path

from .agents.base import Agent, AgentResult, Budget, RunAborted
from .agents.noop import NoopAgent
from .agents.reference import ReferenceAgent
from .config import config_hash
from .report import latest_rows, load_rows
from .sandbox import new_workdir
from .tasks import (REPO_ROOT, Task, lint, lint_set, protected_hashes, run_check,
                    stage_workdir, task_set_hash)

TAIL = 1500  # characters of check output kept per trial


def trial_seed(run_seed: int, task_id: str, trial: int) -> int:
    """Seed for one trial: depends only on the run seed, task and trial index, not the lane."""
    digest = hashlib.sha256(f"{run_seed}:{task_id}:{trial}".encode()).hexdigest()
    return int(digest[:8], 16)


def run_trial(agent: Agent, task: Task, trial: int, budget: Budget, transcript: Path,
              seed: int) -> dict:
    """One agent attempt on a fresh copy of the fixture, then the hidden check.

    An infrastructure error means the task was never attempted, so it is not
    checked or graded; the row only records that the trial is still owed.
    """
    workdir = new_workdir()
    try:
        stage_workdir(task, workdir)
        before = protected_hashes(task, workdir)
        agent.prepare(task)
        try:
            result = agent.run(task.brief, workdir, budget, transcript, seed)
        except RunAborted:
            raise
        except Exception as exc:  # an agent bug must not stop the whole run
            result = AgentResult(status="error", error=f"{type(exc).__name__}: {exc}")
        row = {
            "task_id": task.id, "split": task.split, "category": task.category,
            "family": task.family, "difficulty": task.meta.get("difficulty"),
            "trial": trial, "seed": seed, "lane": agent.lane,
            "passed": False, "check_returncode": None, "check_timed_out": False,
            "check_output_tail": "", "protected_violation": [],
            **result.to_dict(),
        }
        if result.infra_error:
            return row
        after_agent = protected_hashes(task, workdir)
        check = run_check(task, workdir)
        # Hash again: agent code run by the check (on import, say) could rewrite a file.
        after_check = protected_hashes(task, workdir)
        violations = sorted(rel for rel in before
                            if before[rel] != after_agent[rel] or before[rel] != after_check[rel])
        row.update(passed=check.returncode == 0 and not violations,
                   check_returncode=check.returncode, check_timed_out=check.timed_out,
                   check_output_tail=check.output[-TAIL:], protected_violation=violations)
        return row
    finally:
        shutil.rmtree(workdir.parent, ignore_errors=True)


def validate_task(task: Task) -> list[str]:
    """Lint, then: the untouched fixture fails, the reference passes twice, protected files hold."""
    problems = lint(task)
    if problems:
        return problems
    budget = Budget.from_config()
    sink = Path("/dev/null")
    noop = run_trial(NoopAgent(), task, 0, budget, sink, seed=0)
    if noop["passed"]:
        problems.append("check passes on the untouched fixture")
    for attempt in (1, 2):
        ref = run_trial(ReferenceAgent(), task, attempt, budget, sink, seed=0)
        if not ref["passed"]:
            why = ref["protected_violation"] or ref["check_output_tail"].strip()[-300:]
            problems.append(f"reference run {attempt} fails: {why}")
            break
    return problems


def validate(tasks: list[Task]) -> dict[str, list[str]]:
    """Problems per task id ('*' for cross-task problems); empty lists mean valid."""
    report = {"*": lint_set(tasks)}
    for task in tasks:
        report[task.id] = validate_task(task)
    return report


def git_state() -> tuple[str, bool]:
    """Commit of the repo holding this package and whether the tree is dirty."""
    def git(*args: str) -> str:
        res = subprocess.run(["git", "-C", str(REPO_ROOT), *args],
                             capture_output=True, text=True)
        return res.stdout.strip() if res.returncode == 0 else ""
    return git("rev-parse", "HEAD") or "none", bool(git("status", "--porcelain", "."))


def _rel(path: Path) -> str:
    """Repo-relative path where possible, so manifests from in-repo tasks carry no local paths."""
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def redact_url(url: str) -> str:
    """Scheme and port only, host replaced, so results never publish a private hostname."""
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    label = "local" if host in ("localhost", "127.0.0.1", "::1") else "redacted"
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{label}{port}"


def _public_options(options: dict) -> dict:
    return {k: redact_url(v) if k == "base_url" else v for k, v in options.items()}


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def execute(agents: list[Agent], jobs: list[tuple[Task, int, int]], out_dir: Path,
            budget: Budget, run_seed: int, progress: bool) -> None:
    """Run (task, trial, attempt) jobs with one thread per agent (lane), appending rows.

    Work is I/O bound (HTTP and subprocesses), so threads are enough. On Ctrl-C
    or a worker crash the remaining jobs are abandoned and the error re-raised;
    finished rows are already on disk for --resume.
    """
    todo: queue.Queue = queue.Queue()
    for job in jobs:
        todo.put(job)
    stop = threading.Event()
    lock = threading.Lock()
    crashed: list[BaseException] = []

    def worker(agent: Agent) -> None:
        try:
            while not stop.is_set():
                try:
                    task, trial, attempt = todo.get_nowait()
                except queue.Empty:
                    return
                transcript = out_dir / "transcripts" / f"{task.id}-t{trial}-a{attempt}.jsonl"
                seed = trial_seed(run_seed, task.id, trial)
                row = run_trial(agent, task, trial, budget, transcript, seed)
                row["transcript_path"] = (transcript.relative_to(out_dir).as_posix()
                                          if row["transcript_path"] else "")
                with lock:
                    with open(out_dir / "trials.jsonl", "a", encoding="utf-8") as f:
                        f.write(json.dumps(row) + "\n")
                    if progress:
                        mark = ("INFRA" if row["infra_error"]
                                else "PASS" if row["passed"] else "fail")
                        print(f"  t{trial} {task.id:40s} {mark:5s} {row['status']:8s} "
                              f"turns={row['turns']} tools={row['tool_calls']} "
                              f"{row['wall_s']:.1f}s {agent.lane}", flush=True)
        except BaseException as exc:  # an escaped error, or an interrupt raised in this thread
            crashed.append(exc)
            stop.set()

    threads = [threading.Thread(target=worker, args=(a,), daemon=True) for a in agents]
    for t in threads:
        t.start()
    try:
        while any(t.is_alive() for t in threads):
            for t in threads:
                t.join(timeout=0.2)
    except KeyboardInterrupt:
        stop.set()  # let workers finish their current trial, then stop
        print("interrupted: finishing the trials in flight, then stopping"
              " (continue later with --resume)", flush=True)
        for t in threads:
            t.join()
        raise
    if crashed:
        raise crashed[0]


def fill(agents: list[Agent], tasks: list[Task], manifest: dict, out_dir: Path,
         progress: bool = True) -> dict:
    """Run every trial that is missing or infra-failed, retry infra failures, then close.

    Used by a fresh run and by --resume alike; finished trials are never re-run.
    """
    budget = Budget.from_config(manifest["config"])
    by_id = {t.id: t for t in tasks}

    def owed() -> list[tuple[Task, int, int]]:
        raw = load_rows(out_dir)
        latest = latest_rows(raw)
        done = {(r["task_id"], r["trial"]) for r in latest if not r.get("infra_error")}
        attempts: dict[tuple[str, int], int] = {}
        for r in raw:
            key = (r["task_id"], r["trial"])
            attempts[key] = attempts.get(key, 0) + 1
        return [(by_id[tid], trial, attempts.get((tid, trial), 0))
                for trial in range(manifest["trials"]) for tid in manifest["task_ids"]
                if (tid, trial) not in done]

    execute(agents, owed(), out_dir, budget, manifest["seed"], progress)
    for extra in range(manifest["infra_passes"]):
        retry = owed()
        if not retry:
            break
        pause = manifest["infra_backoff_s"] * 2 ** extra
        if progress:
            print(f"  {len(retry)} trial(s) hit infrastructure errors; "
                  f"retry pass {extra + 1} in {pause:g}s", flush=True)
        time.sleep(pause)
        execute(agents, retry, out_dir, budget, manifest["seed"], progress)

    latest = latest_rows(load_rows(out_dir))
    unresolved = sum(1 for r in latest if r.get("infra_error"))
    missing = manifest["trials"] * len(manifest["task_ids"]) - len(latest)
    manifest.update(
        finished=_now(),
        unresolved_infra=unresolved,
        missing_trials=missing,
        complete=unresolved == 0 and missing == 0,
        models_reported=sorted({r["model"] for r in latest if r.get("model")}),
    )
    manifest["mixed_models"] = len(manifest["models_reported"]) > 1
    write_manifest(out_dir, manifest)
    return manifest


def run_suite(agents: list[Agent], tasks: list[Task], trials: int, config: dict,
              out_dir: Path, seed: int, split: str, demo: bool, infra_passes: int = 2,
              infra_backoff_s: float = 30.0, progress: bool = True) -> dict:
    """Start a new run: every task `trials` times, trial-major so drift spreads across tasks."""
    if (out_dir / "trials.jsonl").exists():
        raise FileExistsError(f"{out_dir} already holds a run; use --resume to continue it")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "transcripts").mkdir(exist_ok=True)
    (out_dir / "trials.jsonl").touch()
    commit, dirty = git_state()
    manifest = {
        "agent": agents[0].name,
        "lanes": [a.lane for a in agents],
        "agent_options": _public_options(agents[0].options()),
        "config": config,
        "config_sha256": config_hash(config),
        "models_reported": [],
        "mixed_models": False,
        "demo": demo,
        "date": _now(),
        "finished": None,
        "complete": False,
        "unresolved_infra": None,
        "missing_trials": None,
        "resumed": [],
        "git_commit": commit,
        "git_dirty": dirty,
        "python": platform.python_version(),
        "task_roots": sorted({_rel(t.path.parent) for t in tasks}),
        "split": split,
        "task_set_hash": task_set_hash(tasks),
        "task_ids": [t.id for t in tasks],
        "trials": trials,
        "seed": seed,
        "infra_passes": infra_passes,
        "infra_backoff_s": infra_backoff_s,
    }
    write_manifest(out_dir, manifest)
    return fill(agents, tasks, manifest, out_dir, progress)


def resume_suite(agents: list[Agent], tasks: list[Task], out_dir: Path,
                 progress: bool = True, overrides: dict | None = None) -> dict:
    """Continue a run in place: same tasks, trials, seed and config as its manifest.

    overrides may change only infra_passes and infra_backoff_s. The code that
    resumes is recorded, since it may differ from the code that started.
    """
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    if task_set_hash(tasks) != manifest["task_set_hash"]:
        raise ValueError("the tasks changed since this run started; start a new run instead")
    for key, value in (overrides or {}).items():
        if key not in ("infra_passes", "infra_backoff_s"):
            raise ValueError(f"cannot override {key} on resume")
        if value is not None:
            manifest[key] = value
    commit, dirty = git_state()
    manifest["resumed"].append({"date": _now(), "git_commit": commit, "git_dirty": dirty})
    manifest["finished"] = None
    write_manifest(out_dir, manifest)
    return fill(agents, tasks, manifest, out_dir, progress)


def write_manifest(out_dir: Path, manifest: dict) -> None:
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
