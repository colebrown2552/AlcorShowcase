"""Turn and tool-call table for runs against a baseline (the turn-saver experiment).

    python3 scripts/turns_table.py BASELINE_RUN ARM_RUN [ARM_RUN ...]

Pass-rate differences come from the same paired comparison as `alcorbench compare`
(complete tasks only, task bootstrap, seed from the baseline manifest). Rows written
before tool counts and final context were recorded (the baseline) are read back from
their transcripts; where the transcripts are not present (the public copy keeps them
privately), those rows print "n/a" instead of a partial count.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path
from statistics import fmean, median

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from alcorbench import report, stats  # noqa: E402

TOOLS = ("run_shell", "read_file", "replace_in_file", "write_file", "list_files", "finish")


def from_transcript(run_dir: Path, row: dict) -> tuple[Counter, int, int] | None:
    """Executed tool calls by name, re-reads of a path, and the last turn's prompt tokens.

    None when the transcript file is not present.
    """
    path = run_dir / row["transcript_path"]
    if not path.is_file():
        return None
    counts: Counter = Counter()
    names: dict[str, tuple[str, str]] = {}
    reads: Counter = Counter()
    last = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        if r.get("role") == "assistant":
            last = int((r.get("usage") or {}).get("prompt_tokens") or 0)
            for call in r.get("tool_calls") or []:
                fn = call.get("function") or {}
                try:
                    path = json.loads(fn.get("arguments") or "{}").get("path", "")
                except (json.JSONDecodeError, AttributeError):
                    path = ""
                names[call.get("id", "")] = (fn.get("name", ""), str(path))
        elif r.get("role") == "tool" and not r["content"].startswith("not run"):
            name, path = names.get(r.get("tool_call_id", ""), ("", ""))
            counts[name] += 1
            if name == "read_file":
                reads[path] += 1
    return counts, sum(n - 1 for n in reads.values() if n > 1), last


def describe(run_dir: Path, base: list[dict] | None, seed: int) -> dict:
    manifest, rows = report.load_run(run_dir)
    rows = [r for r in rows if not r.get("infra_error")]
    full = stats.complete_tasks(rows, manifest["trials"])
    tools: Counter = Counter()
    rereads, finals = 0, []
    no_tools = no_rereads = no_finals = False
    for r in rows:
        parsed = from_transcript(run_dir, r)
        if parsed is None:
            no_rereads = True
            no_tools |= not r.get("tool_counts")
            no_finals |= not r.get("final_prompt_tokens")
            tools.update(r.get("tool_counts") or {})
            finals.append(r.get("final_prompt_tokens") or 0)
            continue
        counts, again, last = parsed
        tools.update(r.get("tool_counts") or counts)
        rereads += again
        finals.append(r.get("final_prompt_tokens") or last)
    s = stats.summarize(rows, seed=seed)
    out = {
        "name": run_dir.name, "rows": rows, "complete": manifest.get("complete"),
        "graded": len(rows), "n_tasks": s.n_tasks, "pass": s.mean_pass, "ci": s.ci,
        "first_try": f"{s.first_try_passes} of {s.first_try_tasks}", "flip": s.flip_rate,
        "turns_med": median(r["turns"] for r in rows), "turns_mean": fmean(r["turns"] for r in rows),
        "calls_total": sum(r["tool_calls"] for r in rows), "tools": tools, "rereads": rereads,
        "wall_med": median(r["wall_s"] for r in rows),
        "in_mean": fmean(r["input_tokens"] for r in rows),
        "out_mean": fmean(r["output_tokens"] for r in rows),
        "in_med": median(r["input_tokens"] for r in rows),
        "final_med": None if no_finals else median(finals),
        "no_tools": no_tools, "no_rereads": no_rereads,
        "auto_tests": sum(r.get("auto_tests", 0) for r in rows),
        "auto_test_s": sum(r.get("auto_test_s", 0.0) for r in rows),
        "gate": sum(r.get("finish_gate_rejections", 0) for r in rows),
        "finished": sum(r["status"] == "finished" for r in rows),
    }
    if base is not None:
        paired = full & stats.complete_tasks(base, 3)
        p = stats.paired_compare([r for r in rows if r["task_id"] in paired],
                                 [r for r in base if r["task_id"] in paired], seed=seed)
        out["paired"] = p
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    base_dir = Path(argv[0])
    seed = int(report.load_run(base_dir)[0].get("seed", 0))
    base = describe(base_dir, None, seed)
    arms = [describe(Path(a), base["rows"], seed) for a in argv[1:]]
    runs = [base] + arms
    pct = lambda x: f"{100 * x:.1f}%"  # noqa: E731
    lines = ["| | " + " | ".join(f"`{r['name']}`" for r in runs) + " |",
             "|---|" + "---|" * len(runs)]

    def row(label: str, fn) -> None:
        lines.append(f"| {label} | " + " | ".join(fn(r) for r in runs) + " |")

    row("Graded trials (complete run)", lambda r: f"{r['graded']} ({'yes' if r['complete'] else 'NO'})")
    row("Pass rate (95% CI)", lambda r: f"{pct(r['pass'])} ({pct(r['ci'][0])} to {pct(r['ci'][1])})")
    row("Paired diff vs baseline (95% CI)", lambda r: "-" if "paired" not in r else
        f"{100 * r['paired'].mean_diff:+.1f} pts ({100 * r['paired'].ci[0]:+.1f} to "
        f"{100 * r['paired'].ci[1]:+.1f})")
    row("Tasks better / worse / tied; sign p", lambda r: "-" if "paired" not in r else
        f"{r['paired'].wins} / {r['paired'].losses} / {r['paired'].ties}; {r['paired'].p_sign:.3f}")
    row("First-try passes", lambda r: r["first_try"])
    row("Flip rate", lambda r: pct(r["flip"]) if r["flip"] is not None else "-")
    row("Turns: median / mean", lambda r: f"{r['turns_med']:g} / {r['turns_mean']:.1f}")
    row("Tool calls: total (per trial)", lambda r: f"{r['calls_total']} ({r['calls_total'] / r['graded']:.1f})")
    for name in TOOLS:
        row(f"&nbsp; {name}", lambda r, n=name: "n/a" if r["no_tools"] else str(r["tools"].get(n, 0)))
    row("&nbsp; read_file re-reads of a path", lambda r: "n/a" if r["no_rereads"] else str(r["rereads"]))
    row("Median seconds per trial", lambda r: f"{r['wall_med']:.1f}")
    row("Mean input / output tokens per trial", lambda r: f"{r['in_mean']:,.0f} / {r['out_mean']:,.0f}")
    row("Median input tokens per trial", lambda r: f"{r['in_med']:,.0f}")
    row("Final context, median prompt tokens",
        lambda r: "n/a" if r["final_med"] is None else f"{r['final_med']:,.0f}")
    row("Auto-test runs (total seconds)", lambda r: f"{r['auto_tests']} ({r['auto_test_s']:.0f}s)")
    row("Finish-gate rejections", lambda r: str(r["gate"]))
    row("Trials ended by finish", lambda r: f"{r['finished']} of {r['graded']}")
    print("\n".join(lines))
    for arm in arms:
        changed = {t: d for t, d in arm["paired"].diffs.items() if d}
        fa = stats.pass_fractions(stats.per_task(arm["rows"]))
        fb = stats.pass_fractions(stats.per_task(base["rows"]))
        print(f"\nTasks that changed in `{arm['name']}` (passes of 3, baseline -> arm):")
        for t, d in sorted(changed.items(), key=lambda kv: (kv[1], kv[0])):
            print(f"- {t}: {round(3 * fb[t])} -> {round(3 * fa[t])}")
        if not changed:
            print("- none")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
