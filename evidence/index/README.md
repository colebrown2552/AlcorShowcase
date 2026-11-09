# index-bench

This folder holds a versioned, seeded benchmark of
AlcorIndex-style filename search: a baseline scan against a trigram FTS5 index over a public synthetic corpus, with result-identity
checks. Layout: `bench/index_bench.py` (generator and benchmark); `benchmarks/results/<run-id>/` (manifest and raw observations of recorded runs).

## Run

Python 3.12, standard library only (sqlite3 with FTS5 trigram). `ALCOR_ROOT` is optional (there is no default; the source tree is not public): if set, `AlcorIndex/alcor_index.py` is read once to record its sha256, otherwise that field reads "unavailable".

    # quick reproduce (20,000 records)
    python3 -B bench/index_bench.py --records 20000 --seed 20261108 --workdir "$(mktemp -d)"
    # full reproduce (1,000,000 records)
    python3 -B bench/index_bench.py --records 1000000 --seed 20261108 --workdir <existing empty dir>

Options: `--records N`, `--seed S`, `--workdir DIR` (existing directory; the only place written), `--rounds R` (timed rounds, default 5,
minimum 3), `--warmup-rounds` (default 1), `--inject-fts-fault` (drops one FTS hit from one query so the run must report a mismatch).
Output in DIR: `corpus.sqlite`, `queries.jsonl` (300 queries, raw timings and result hashes), `manifest.json`.

## Results

Newest recorded run: `20261108-r1m-s20261108-opt` (1,000,000 synthetic records, seed 20261108).

Headline figures from its `manifest.json`:

- records: 1000000; queries: 300; mismatches: 0
- scan warm p50 / p95: 48.467 ms / 66.298 ms
- FTS warm p50 / p95: 2.936 ms / 49.301 ms
- build_seconds: 9.525
- hardware: cores 20, ram_gb 121.6, cpu_model `0xd87` (as recorded)

Per-category table, pasted verbatim from `python3 -B tools/summarize_results.py benchmarks/results/20261108-r1m-s20261108-opt`:

| category | n | mismatches | scan p50 ms | scan p95 ms | FTS p50 ms | FTS p95 ms |
|---|---|---|---|---|---|---|
| common | 60 | 0 | 49.814 | 58.611 | 24.338 | 43.549 |
| rare | 60 | 0 | 48.585 | 54.576 | 2.039 | 4.886 |
| multi_term | 50 | 0 | 53.985 | 89.727 | 4.587 | 41.995 |
| filter | 50 | 0 | 46.626 | 54.258 | 2.962 | 10.362 |
| case_variant | 30 | 0 | 47.573 | 53.462 | 2.086 | 3.250 |
| no_match | 25 | 0 | 38.692 | 42.032 | 0.071 | 0.094 |
| boundary | 25 | 0 | 41.580 | 78.193 | 37.691 | 266.526 |
| overall | 300 | 0 | 48.467 | 66.298 | 2.936 | 49.301 |

Quick reproduce command:

    python3 -B bench/index_bench.py --records 20000 --seed 20261108 --workdir "$(mktemp -d)"

Note: the `reproduce_*` strings inside the committed manifests omit the required `--workdir` flag; add it as above.

### Before and after

The earlier run `20261108-r1m-s20261108` recorded an FTS warm p95 of 67.168 ms (p50 3.618 ms); the newest run records 49.301 ms (p50 2.936 ms) beside it. The scan arm was not changed: its p95 was 67.157 ms in the earlier run and is 66.298 ms in the newest. Between the two runs the FTS arm changed in how it reads ids: it fetches rows in one call and skips a no-op join when a query has no extra filter. Both runs are single runs on a shared machine, not repeated measurements, so the difference is not a controlled comparison.

### What the FTS tail looks like

The tail profile `profiles/fts_tail_1m.json` was taken on the earlier run. In it, the time at the 95th percentile is mostly spent fetching rows rather than executing the query: the fetch share is 0.99 for `common` and 0.96 for `boundary`. The `boundary` queries are the slowest class; the profile's plan for its sampled query shows a full table scan returning all 1000000 rows, and 11 of its 25 queries have samples in the tail, all 11 containing a term of 1-2 characters. The profile does not establish why `common` and `boundary` fetches are slow beyond the volume of rows returned, so the underlying cause is unconfirmed. In the newest run, `boundary` still has the largest FTS p95 of any class and it rose in this single run, from 236.890 ms in the tail profile to 266.526 ms in the table above, while the overall p95 fell (67.168 ms to 49.301 ms) and the `common` p95 fell (68.484 ms to 43.549 ms). The tail is therefore not removed, and the `boundary` figure did not improve.

### Limitations

The corpus is synthetic ASCII with invented words, not real file trees. Timings are warm-cache only; caches are never dropped. All figures come from one machine, and each run is a single run. Ranking, bm25 and result limits are not benchmarked, and non-ASCII case folding is not exercised.
