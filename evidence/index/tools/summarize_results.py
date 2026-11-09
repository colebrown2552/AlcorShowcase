#!/usr/bin/env python3
"""Per-category scan/FTS summary for one results dir (stdlib only, read-only).

Usage: python3 -B tools/summarize_results.py <results-dir> [--json]
"""
import json
import os
import sys



def pct(vals, p):
    # Identical to pct in bench/index_bench.py. It is repeated here, not imported,
    # because the repo check requires this tool to import only the standard library.
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, round((len(s) - 1) * p)))]

COLS = ["n", "mismatches", "scan_p50_ms", "scan_p95_ms", "fts_p50_ms", "fts_p95_ms"]


def stats(rows):
    scan = [x for r in rows for x in r["scan_ms"]]
    fts = [x for r in rows for x in r["fts_ms"]]
    bad = sum(1 for r in rows if r["scan_n"] != r["fts_n"] or r["scan_ids_sha256"] != r["fts_ids_sha256"])
    u = {"scan_p50_ms": pct(scan, 0.5), "scan_p95_ms": pct(scan, 0.95),
         "fts_p50_ms": pct(fts, 0.5), "fts_p95_ms": pct(fts, 0.95)}
    d = {"n": len(rows), "mismatches": bad}
    d.update(u)  # JSON values are unrounded; only the table rounds
    d["unrounded"] = u
    return d


def main(argv):
    args = [a for a in argv if a != "--json"]
    if len(args) != 1:
        sys.exit("usage: summarize_results.py <results-dir> [--json]")
    rows = []
    with open(os.path.join(args[0], "queries.jsonl")) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    groups = {}
    for r in rows:
        groups.setdefault(r["category"], []).append(r)
    cats = {k: stats(v) for k, v in groups.items()}
    overall = stats(rows)
    if "--json" in argv:
        print(json.dumps({"overall": overall, "categories": cats}, indent=2))
        return
    print("| category | n | mismatches | scan p50 ms | scan p95 ms | FTS p50 ms | FTS p95 ms |")
    print("|---|---|---|---|---|---|---|")
    for name, d in list(cats.items()) + [("overall", overall)]:
        print(f"| {name} | {d['n']} | {d['mismatches']} | " + " | ".join(f"{d[k]:.3f}" for k in COLS[2:]) + " |")


if __name__ == "__main__":
    main(sys.argv[1:])
