#!/usr/bin/env python3
"""Where does the FTS p95 tail come from? Per-query-class profile (stdlib only).

Usage: python3 -B tools/profile_fts.py <results-dir> [--live --records N --seed S --workdir DIR]

Prints JSON. `tail` comes only from <results-dir>/queries.jsonl. `live` (with --live) builds a
corpus in DIR with the bench's own build_db/plan_queries/make_fts and times execute and row
fetching separately. DIR must be an empty directory; the files created in it are deleted afterwards.
"""
import argparse
import importlib.util
import json
import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def load_bench():
    spec = importlib.util.spec_from_file_location("index_bench", os.path.join(HERE, "..", "bench", "index_bench.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def pct(vals, p):  # same as the bench's pct
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, round((len(s) - 1) * p)))]


def tail_section(results_dir):
    rows = []
    with open(os.path.join(results_dir, "queries.jsonl")) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    thr = pct([x for r in rows for x in r["fts_ms"]], 0.95)
    groups = {}
    for r in rows:
        groups.setdefault(r["category"], []).append(r)
    classes = {}
    for name, qq in groups.items():
        samples = [x for r in qq for x in r["fts_ms"]]
        short = [any(len(t) < 3 for t in r["terms"]) for r in qq]
        hit = [any(x >= thr for x in r["fts_ms"]) for r in qq]
        classes[name] = {
            "n": len(qq), "fts_p95_ms": pct(samples, 0.95),
            "tail_samples": sum(x >= thr for x in samples), "tail_queries": sum(hit),
            "short_term_queries": sum(short), "tail_short_term_queries": sum(a and b for a, b in zip(short, hit)),
        }
    return {"threshold_ms": thr, "classes": classes}


class TimingCursor:
    def __init__(self, cur, sink):
        self.cur, self.sink = cur, sink

    def fetchall(self):
        t = time.perf_counter()
        rows = self.cur.fetchall()
        self.sink["fetch"] += (time.perf_counter() - t) * 1000
        return rows

    def __iter__(self):
        return iter(self.fetchall())


class TimingConn:
    """Thin proxy: execute() is timed; the returned cursor times the row fetching."""

    def __init__(self, con):
        self.con, self.sink, self.last = con, {"execute": 0.0, "fetch": 0.0}, None

    def execute(self, sql, args=()):
        self.last = (sql, list(args))
        t = time.perf_counter()
        cur = self.con.execute(sql, args)
        self.sink["execute"] += (time.perf_counter() - t) * 1000
        return TimingCursor(cur, self.sink)


def live_section(records, seed, workdir, rounds=5):
    if not os.path.isdir(workdir) or os.listdir(workdir):
        sys.exit("profile_fts: --workdir must be an existing empty directory")
    bench = load_bench()
    os.environ["SQLITE_TMPDIR"] = workdir
    db = os.path.join(workdir, "corpus.sqlite")
    try:
        _, stats, _ = bench.build_db(db, records, seed)
        qs = bench.plan_queries(seed, stats)
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        tc = TimingConn(con)
        fts = bench.make_fts(tc)
        for q in qs:  # warm-up round, untimed
            fts(q)
        samples = {}
        plans = {}
        best = {}
        for _ in range(rounds):
            for q in qs:
                tc.sink["execute"] = tc.sink["fetch"] = 0.0
                n = len(fts(q))
                e, f = tc.sink["execute"], tc.sink["fetch"]
                samples.setdefault(q["category"], []).append((e, f, e + f))
                if n >= best.get(q["category"], (-1,))[0]:
                    best[q["category"]] = (n, q["id"], tc.last)
        for cat, (n, qid, (sql, args)) in best.items():
            plan = [r[3] for r in con.execute("EXPLAIN QUERY PLAN " + sql, args)]
            plans[cat] = {"query_id": qid, "rows": n, "text": plan}
        con.close()
    finally:
        for s in ("", "-journal", "-wal", "-shm"):
            if os.path.exists(db + s):
                os.remove(db + s)
    classes = {}
    for cat, ss in samples.items():
        tot = sum(x[2] for x in ss)
        classes[cat] = {
            "execute_ms_p95": pct([x[0] for x in ss], 0.95), "fetch_ms_p95": pct([x[1] for x in ss], 0.95),
            "total_ms_p95": pct([x[2] for x in ss], 0.95),
            "fetch_share": (sum(x[1] for x in ss) / tot) if tot else 0.0,
            "plan": plans[cat],
        }
    return {"records": records, "seed": seed, "rounds": rounds, "classes": classes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results_dir")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--records", type=int)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--workdir")
    a = ap.parse_args()
    out = {"results_run": os.path.basename(os.path.normpath(a.results_dir)), "tail": tail_section(a.results_dir)}
    if a.live:
        if a.records is None or a.seed is None or not a.workdir:
            sys.exit("profile_fts: --live needs --records, --seed and --workdir")
        out["live"] = live_section(a.records, a.seed, os.path.abspath(a.workdir))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
