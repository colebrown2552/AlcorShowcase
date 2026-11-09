#!/usr/bin/env python3
"""Replay Alcor's review stage on past portfolio attempts and score it against the Opus verdict each one got.

The question it answers: if Alcor had read this attempt first, would it have sent back what Opus failed, and let through what Opus passed?
Inputs are what each run left on disk: the diff it was reviewed on (runs/<id>/diff.patch), the node's brief and guides, the report, and the
findings the driver was told to fix. Reports are the latest on disk, so for an early attempt they may be a later attempt's report.

  python3 -B alcor_calibrate.py [--think both|on|off] [--limit N]
Writes a new research/alcor-calibration-<utc>.json every run (old results stay as evidence) and prints the summary.
"""
from __future__ import annotations

import argparse, json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = Path(os.environ.get("CALIB_RUNS", "runs"))        # directory of past run folders (not shipped)
OUT = Path(os.environ.get("CALIB_OUT", "out"))
LANES = [x for x in os.environ.get("CALIB_LANES", "").split(",") if x]   # model lane names, comma separated
SAMPLES, AGREE = 1, 1                                        # set by --samples/--agree


def verdicts(d):
    """(sonnet verdict, opus verdict, opus findings text) from the run's review sessions."""
    son = opus = None
    text = ""
    for spec in sorted(d.glob("spec.*.json")):
        a = json.loads(spec.read_text())["argv"]
        if "--json-schema" not in a:
            continue
        try:
            s = json.loads((d / f"exit.{spec.name.split('.')[1]}.json").read_text()).get("structured") or {}
        except (OSError, ValueError):
            continue
        model = a[a.index("--model") + 1]
        if "opus" in model and s.get("verdict"):
            opus = s["verdict"]
            text = " ".join(f"{f.get('where', '')} {f.get('why', '')}" for f in s.get("findings") or [] if f.get("severity") == "block")
        elif "sonnet" in model and s.get("verdict"):
            son = s["verdict"]
    return son, opus, text


def cases():
    out = []
    for d in sorted(RUNS.iterdir()):
        rec = d / "record.json"
        if not (d / "diff.patch").exists() or not rec.exists():
            continue
        r = json.loads(rec.read_text())
        if r.get("kind") != "node":
            continue
        son, opus, text = verdicts(d)
        if not opus:
            continue
        cycle = Path(r["cycle"])
        prior = d / "calib-prior.md"
        p = (d / "prompt.md").read_text(errors="ignore") if (d / "prompt.md").exists() else ""
        m = re.search(r"LAST ATTEMPT FAILED, fix exactly this:\n(.*)", p, re.S)
        prior_text = m.group(1)[:4000] if m else ""
        out.append({"run": d.name, "node": r["node"], "attempt": r.get("attempt"), "sonnet": son, "opus": opus, "opus_text": text,
                    "brief": str(cycle / "briefs" / f"{r['node']}.md"), "report": str(cycle / r["output"]), "diff": str(d / "diff.patch"),
                    "prior_text": prior_text, "guides": [str(g) for g in sorted(cycle.glob("*.md")) if g.name != "objective.md"]})
    return out


def run_one(c, think, lane, tmp):
    argv = [sys.executable, "-B", str(HERE / "alcor_review.py"), "node", "--brief", c["brief"], "--report", c["report"], "--diff", c["diff"], "--lane", lane, "--deadline-min", "20",
            "--samples", str(SAMPLES), "--agree", str(AGREE)]
    if c["prior_text"]:
        pf = tmp / f"{c['run']}.prior.md"
        pf.write_text(c["prior_text"])
        argv += ["--prior", str(pf)]
    for g in c["guides"]:
        argv += ["--guide", g]
    if think:
        argv.append("--think")
    r = subprocess.run(argv, capture_output=True, text=True, timeout=1500)
    try:
        x = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        x = {"is_error": True, "result": (r.stdout + r.stderr)[-300:]}
    s = x.get("structured_output") or {}
    words = lambda t: set(re.findall(r"[a-z0-9']{4,}", t.lower()))
    ow = words(c["opus_text"])
    matched = sum(1 for f in s.get("findings") or [] if f.get("severity") == "block" and len(words(f.get("quote", "")) & ow) >= 3)
    return {**{k: c[k] for k in ("run", "node", "attempt", "sonnet", "opus")}, "think": think, "error": x.get("result") if x.get("is_error") else None,
            "alcor": s.get("verdict"), "blocks": sum(1 for f in s.get("findings") or [] if f.get("severity") == "block"), "matched_opus": matched,
            "dropped": len((s.get("alcor") or {}).get("dropped") or []), "seconds": (s.get("alcor") or {}).get("seconds"),
            "truncated": (s.get("alcor") or {}).get("truncated"), "usage": (x.get("modelUsage") or {}).get("alcor-35b"), "findings": s.get("findings")}


def score(rows):
    ok = [r for r in rows if r["alcor"]]
    f = [r for r in ok if r["opus"] == "fail"]
    p = [r for r in ok if r["opus"] == "pass"]
    leak = [r for r in f if r["sonnet"] == "pass"]
    fail_rows = [r for r in ok if r["alcor"] == "fail"]
    return {"n": len(rows), "answered": len(ok), "errors": len(rows) - len(ok),
            "catch_rate_on_opus_fail": round(sum(r["alcor"] == "fail" for r in f) / max(1, len(f)), 2), "opus_fail": len(f),
            "false_alarm_on_opus_pass": round(sum(r["alcor"] == "fail" for r in p) / max(1, len(p)), 2), "opus_pass": len(p),
            "caught_after_sonnet_pass": f"{sum(r['alcor'] == 'fail' for r in leak)}/{len(leak)}",
            "precision_of_alcor_fail": round(sum(r["opus"] == "fail" for r in fail_rows) / max(1, len(fail_rows)), 2),
            "alcor_fails_naming_an_opus_problem": f"{sum(r['matched_opus'] > 0 for r in fail_rows if r['opus'] == 'fail')}/{sum(r['opus'] == 'fail' for r in fail_rows)}",
            "dropped_unverified_findings": sum(r["dropped"] for r in ok),
            "median_seconds": sorted(r["seconds"] or 0 for r in ok)[len(ok) // 2] if ok else None,
            "output_tokens": sum((r["usage"] or {}).get("outputTokens", 0) for r in ok), "input_tokens": sum((r["usage"] or {}).get("inputTokens", 0) for r in ok)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--think", choices=["both", "on", "off"], default="both")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--agree", type=int, default=2)
    a = ap.parse_args()
    global SAMPLES, AGREE
    SAMPLES, AGREE = a.samples, a.agree
    if not LANES:
        sys.exit("CALIB_LANES is empty: nothing to call. Replays live in data/replays.json.")
    cs = cases()[: a.limit or None]
    modes = {"both": [False, True], "on": [True], "off": [False]}[a.think]
    OUT.mkdir(exist_ok=True)
    tmp = OUT / "calib-tmp"
    tmp.mkdir(exist_ok=True)
    jobs = [(c, t) for t in modes for c in cs]
    t0 = time.time()
    with ThreadPoolExecutor(len(LANES)) as pool:
        rows = list(pool.map(lambda ij: run_one(ij[1][0], ij[1][1], LANES[ij[0] % len(LANES)], tmp), enumerate(jobs)))
    summary = {str(t): score([r for r in rows if r["think"] == t]) for t in modes}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = OUT / f"alcor-calibration-{stamp}.json"
    path.write_text(json.dumps({"utc": stamp, "wall_seconds": round(time.time() - t0), "cases": len(cs), "samples": SAMPLES, "agree": AGREE,
                                "reviewer_sha256": __import__("hashlib").sha256((HERE / "alcor_review.py").read_bytes()).hexdigest(), "summary": summary, "rows": rows}, indent=1))
    print(json.dumps(summary, indent=1))
    print(path)


if __name__ == "__main__":
    main()
