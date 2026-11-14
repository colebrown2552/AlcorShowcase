"""Markdown reports for one run and paired comparisons of two runs."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from statistics import fmean, median

from . import stats

MIN_TASKS, MIN_TRIALS = 20, 3  # below these a result is labelled preliminary
MIN_CI_TASKS = 10  # below this a task bootstrap or Wilson interval says little: none is shown


def load_rows(run_dir: Path) -> list[dict]:
    """Every row of trials.jsonl, retries included, in the order written."""
    path = run_dir / "trials.jsonl"
    if not path.exists():
        return []
    return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def latest_rows(rows: list[dict]) -> list[dict]:
    """The last row written for each (task, trial): the one that counts after retries."""
    latest = {(r["task_id"], r["trial"]): r for r in rows}
    return list(latest.values())


def load_run(run_dir: Path) -> tuple[dict, list[dict]]:
    manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    return manifest, latest_rows(load_rows(run_dir))


def labels(manifest: dict, rows: list[dict]) -> list[str]:
    """Honesty labels that must travel with any number from this run."""
    out = []
    if manifest.get("demo"):
        out.append("DEMO: scripted agent, no model. Not a result.")
    n_tasks = len(manifest.get("task_ids") or {r["task_id"] for r in rows})
    if n_tasks < MIN_TASKS:
        out.append(f"PRELIMINARY: {n_tasks} tasks (fewer than {MIN_TASKS}).")
    if manifest.get("trials", 0) < MIN_TRIALS:
        out.append(f"PRELIMINARY: {manifest.get('trials')} trial(s) per task "
                   f"(fewer than {MIN_TRIALS}).")
    infra = sum(1 for r in rows if r.get("infra_error"))
    missing = manifest.get("trials", 0) * len(manifest.get("task_ids", [])) - len(rows)
    if manifest.get("finished") is None:
        out.append("INCOMPLETE: the run did not finish (python3 -m alcorbench run --resume).")
    elif infra or missing > 0:
        out.append(f"INCOMPLETE: {infra} trial(s) still have infrastructure errors and "
                   f"{max(missing, 0)} are missing; they are excluded from every rate.")
    models = manifest.get("models_reported") or []
    if len(models) > 1:
        out.append(f"MIXED MODELS: the endpoint reported {len(models)} model names "
                   f"({', '.join(models)}); this run is not a score for one model.")
    resumes = manifest.get("resumed") or []
    if manifest.get("git_dirty") or any(r.get("git_dirty") for r in resumes):
        out.append("Uncommitted changes were present in the repo during this run.")
    if any(r.get("git_commit") != manifest.get("git_commit") for r in resumes):
        out.append("Resumed with code from a different commit than the run started with.")
    return out


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _ci(ci: tuple[float, float]) -> str:
    return f"{_pct(ci[0])} to {_pct(ci[1])}"


def _row(name: str, rows: list[dict], seed: int, task_ids: set[str], trials: int) -> str:
    """One table line over graded (non-infra) rows; intervals only from MIN_CI_TASKS tasks."""
    graded = [r for r in rows if not r.get("infra_error")]
    floor = _pct(stats.pass_rate_lower_bound(rows, task_ids, trials))
    if not graded:
        return f"| {name} | 0 | no graded trials | | {floor} | | | | | | |"
    s = stats.summarize(graded, seed=seed)
    wide = s.n_tasks >= MIN_CI_TASKS
    flips = "n/a" if s.flip_rate is None else _pct(s.flip_rate)
    return (f"| {name} | {s.n_tasks} | {_pct(s.mean_pass)} | {_ci(s.ci) if wide else '-'} "
            f"| {floor} "
            f"| {s.first_try_passes}/{s.first_try_tasks} | {_ci(s.first_try_ci) if wide else '-'} "
            f"| {flips} "
            f"| {median(r['wall_s'] for r in graded):.1f} "
            f"| {fmean(r['tool_calls'] for r in graded):.1f} "
            f"| {fmean(r['input_tokens'] for r in graded):,.0f} / "
            f"{fmean(r['output_tokens'] for r in graded):,.0f} |")


def render(manifest: dict, rows: list[dict]) -> str:
    """The run report: who/what/when, labels, then pass rates by slice."""
    seed = int(manifest.get("seed", 0))
    lanes = ", ".join(lane for lane in manifest.get("lanes", []) if lane) or "-"
    models = ", ".join(manifest.get("models_reported") or []) or "-"
    out = [
        f"# AlcorBench run: {manifest['agent']} / {models}",
        "",
        f"- Date (UTC): {manifest['date']}; finished: {manifest.get('finished') or 'no'}"
        + (f"; resumed {len(manifest['resumed'])} time(s)" if manifest.get("resumed") else ""),
        f"- Agent: `{manifest['agent']}`; lanes (model ids requested): `{lanes}`;"
        f" reported by endpoint: `{models}`",
        f"- Config sha256: `{manifest['config_sha256'][:16]}`",
        f"- Tasks: {len(manifest['task_ids'])} ({manifest.get('split')}),"
        f" trials per task: {manifest['trials']}, seed: {seed}",
        f"- Task set hash: `{manifest['task_set_hash'][:16]}`; code commit:"
        f" `{manifest['git_commit'][:12]}`; Python {manifest['python']}",
        "",
    ]
    out += [f"> {label}" for label in labels(manifest, rows)]
    if not any(not r.get("infra_error") for r in rows):
        return "\n".join(out + ["", "No graded trials."]) + "\n"
    out += [
        "",
        "Pass rate is the mean over tasks of each task's pass fraction across graded trials,",
        f"with a task-level bootstrap 95% CI (shown only for slices of {MIN_CI_TASKS}+ tasks).",
        "Floor is the pass rate if every infra-failed or missing trial had failed. First try",
        "is trial 0 only, with a Wilson 95% interval (same size rule). Flip rate is the share",
        "of repeated tasks whose trials disagree. Infra-failed trials (endpoint unreachable or",
        "busy before any model output) are excluded from every other column.",
        "",
        "| Slice | Tasks | Pass rate | 95% CI | Floor | First try | First-try 95% CI "
        "| Flip rate | Median wall s | Mean tool calls | Mean tokens in / out |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
        _row("all", rows, seed, set(manifest["task_ids"]), manifest["trials"]),
    ]
    for key in ("split", "category"):
        for value in sorted({r[key] for r in rows}):
            part = [r for r in rows if r[key] == value]
            out.append(_row(f"{key}: {value}", part, seed, {r["task_id"] for r in part},
                            manifest["trials"]))
    graded = [r for r in rows if not r.get("infra_error")]
    status = Counter(r["status"] for r in graded)
    violations = sum(1 for r in graded if r["protected_violation"])
    infra = len(rows) - len(graded)
    by_lane = Counter(r.get("lane") or "-" for r in graded)
    out += [
        "",
        "Agent status per graded trial: "
        + ", ".join(f"{k} {v}" for k, v in sorted(status.items()))
        + f"; protected-file violations: {violations};"
        f" unresolved infrastructure errors (excluded): {infra}.",
        "Graded trials per lane: " + ", ".join(f"{k} {v}" for k, v in sorted(by_lane.items())) + ".",
        "",
        "| Task | Split | Passed / graded trials | Infra-failed trials |",
        "|---|---|---|---|",
    ]
    outcomes = stats.per_task(rows)
    for task_id in sorted({r["task_id"] for r in rows}):
        graded_t = outcomes.get(task_id, {})
        split = next(r["split"] for r in rows if r["task_id"] == task_id)
        infra_t = sum(1 for r in rows if r["task_id"] == task_id and r.get("infra_error"))
        out.append(f"| {task_id} | {split} | {sum(graded_t.values())}/{len(graded_t)}"
                   f" | {infra_t} |")
    return "\n".join(out) + "\n"


def render_compare(run_a: tuple[dict, list[dict]], run_b: tuple[dict, list[dict]],
                   names: tuple[str, str]) -> str:
    """Paired comparison: bootstrap CI of the mean per-task difference plus a sign test.

    Only tasks graded on every trial in both runs are paired, so an outage in
    one run cannot tilt the comparison through a partial task.
    """
    (ma, ra), (mb, rb) = run_a, run_b
    for name, m in ((names[0], ma), (names[1], mb)):
        if len(m.get("models_reported") or []) > 1:
            raise ValueError(f"{name} mixes model names {m['models_reported']}; "
                             "a paired comparison needs one model per run")
    full_a = stats.complete_tasks(ra, ma["trials"])
    full_b = stats.complete_tasks(rb, mb["trials"])
    shared_ids = set(ma["task_ids"]) & set(mb["task_ids"])
    paired = full_a & full_b & shared_ids
    keep_a = [r for r in ra if r["task_id"] in paired]
    keep_b = [r for r in rb if r["task_id"] in paired]
    out = [f"# Paired comparison: A = {names[0]}, B = {names[1]}", ""]
    if ma["task_set_hash"] != mb["task_set_hash"]:
        out.append("> WARNING: the runs used different task sets; only shared task ids are compared,"
                   " and a task edited between runs is not the same task.")
    if ma.get("config_sha256") == mb.get("config_sha256"):
        out.append("> Both runs used the same agent config.")
    only = len(set(ma["task_ids"]) ^ set(mb["task_ids"]))
    if only:
        out.append(f"> {only} task(s) appear in only one run and are left out.")
    dropped = len(shared_ids) - len(paired)
    if dropped:
        out.append(f"> {dropped} shared task(s) dropped: not graded on every trial in both runs"
                   " (missing or infrastructure-failed trials).")
    for name, m, r in (("A", ma, ra), ("B", mb, rb)):
        out += [f"> {name}: {label}" for label in labels(m, r)]
        floor = stats.pass_rate_lower_bound(r, set(m["task_ids"]), m["trials"])
        graded = [x for x in r if not x.get("infra_error")]
        rate = _pct(stats.summarize(graded).mean_pass) if graded else "no graded trials"
        out.append(f"> {name} overall: pass rate {rate} over graded trials; floor {_pct(floor)}"
                   " counting infra-failed and missing trials as failures.")
    if not paired:
        return "\n".join(out + ["", "No task is complete in both runs; nothing to compare."]) + "\n"
    p = stats.paired_compare(keep_a, keep_b, seed=int(ma.get("seed", 0)))
    interval = (f", bootstrap 95% CI {100 * p.ci[0]:+.1f} to {100 * p.ci[1]:+.1f}"
                if len(p.tasks) >= MIN_CI_TASKS
                else f" (no interval: fewer than {MIN_CI_TASKS} paired tasks)")
    out += [
        "",
        f"- Paired tasks: {len(p.tasks)}",
        f"- Mean pass fraction on paired tasks (all complete, so this is also the floor):"
        f" A {_pct(p.mean_a)}, B {_pct(p.mean_b)}",
        f"- Mean per-task difference A - B: {100 * p.mean_diff:+.1f} points{interval}",
        f"- Sign test over tasks: A better on {p.wins}, B better on {p.losses}, tied {p.ties};"
        f" exact two-sided p = {p.p_sign:.4f}",
        "",
    ]
    changed = {t: d for t, d in p.diffs.items() if d}
    if changed:
        out += ["| Task | A - B (pass fraction) |", "|---|---|"]
        out += [f"| {t} | {d:+.2f} |" for t, d in sorted(changed.items())]
    else:
        out.append("No task changed.")
    return "\n".join(out) + "\n"
