# Evidence

The index and cascade results below can be re-run from this folder with Python 3.12 and the standard library; the recovery suite needs a private kernel module, so only its raw trials can be inspected here. Manifest `commit` and sha fields refer to a private source tree. Every section gives the exact command,
the figure from the original run (2026-11-08, NVIDIA DGX Spark, Python 3.12.3), the figure from an independent re-run
(2026-11-08, same machine, plain environment `env -i HOME=$HOME PATH=/usr/bin:/bin`, fresh output directory), and the limits. Where the two
differ, both are shown. The committed raw result files under each `results/` or `benchmarks/results/` folder are the original run's and are not overwritten.

## 1. Search index benchmark (`index/`)

- **Measured:** exact-substring filename search over 1,000,000 synthetic records, using a SQLite FTS5 trigram index versus a plain in-memory Python scan. 300 queries in 7 classes; the full unlimited result-id set of both arms is compared for every query.
- **Command (from `evidence/index/`):** `python3 -B bench/index_bench.py --records 1000000 --seed 20261108 --workdir <existing empty dir>`. A 20,000-record quick run: `--records 20000`.
- **Dataset / n / seed:** generated corpus, 1,000,000 records, 300 queries, seed 20261108, 5 timed rounds after 1 warm-up. Corpus hash `15790432913151c8853b3ca1888c48a6fcbf312caef4045ebab8f1b62ae46e04` (identical in both runs).
- **Figure (original run, `benchmarks/results/20261108-r1m-s20261108-opt/manifest.json`):** 0 mismatches in 300 queries; warm median 2.936 ms (FTS) vs 48.467 ms (scan); warm p95 49.301 ms vs 66.298 ms.
- **Figure (re-run):** 0 mismatches in 300 queries; warm median 3.026 ms vs 49.416 ms; warm p95 49.929 ms vs 68.180 ms. Exit code 0.
- **Limits:** synthetic ASCII corpus with invented words, not real file trees; warm cache only; the scan baseline is an in-memory Python loop over preloaded rows, not a disk-based tool; ranking, bm25 and result limits are not measured; single runs on a shared machine. The p95 tail (queries with 1-2 character terms) is not removed. See `index/README.md` for the per-class table.
- **Copy change:** the script originally recorded the hash of a private source file and a repo commit in the manifest; in this copy those fields read "unavailable" when the sources are absent.

## 2. Recovery fault-injection suite (`recovery/`)

- **Measured:** 10 fault families x 30 trials = 300 trials of interrupted work against a sandboxed task ledger and a fake effect receiver; whether each trial is recovered or quarantined, and whether any effect was applied twice.
- **Command (from `evidence/recovery/`):** `python3 -B fault_suite.py --seed 20261108 --workdir <existing empty dir>` (about 9 seconds).
- **Dataset / n / seed:** 300 trials, seed 20261108, 1 s lease.
- **Figure (original run, `results/20261108-t300-s20261108/manifest.json`):** real-seam retry-safe cohort 120 trials: 90 recovered, 30 quarantined, 0 failed, 0 duplicate effects. All 300 trials: 210 recovered, 90 quarantined, 0 failed, 0 duplicate effects; 270 of 270 expected effects observed.
- **Figure (re-run):** identical counts (120: 90 / 30 / 0 / 0; 300: 210 / 90 / 0 / 0; 270 of 270). Timings differ slightly: real-seam retry-safe p95 1.100 s original vs 1.107 s re-run; all-recovered p95 1.089 s vs 1.093 s. Exit code 0.
- **Limits:** loopback receiver only; faults are injected at fixed points, not found by chance; trials per family are small. Only 4 families use the real task-ledger code (before-reservation, worker-exit-before-dispatch, stale-lease-generation, stop-while-pending); the 6 simulated-seam families are excluded from the 120-trial figure. The 30 quarantined trials in that 120-trial cohort are all stop-while-pending trials (checked against `results/20261108-t300-s20261108/trials.jsonl`). The ledger has no worker-generation fence, so a stale worker's late effect is withheld by the suite, not by the receiver.
- **Not standalone:** the real-seam families import the task-ledger module of the private Alcor kernel, which is not published here. The suite exits with "ALCOR_ROOT is not set" without it, so a reader can inspect the code, matrix and raw trials but cannot re-run it from this repo alone. The re-run above used the private tree via `ALCOR_ROOT`.

## 3. Review cascade (`cascade/`)

- **Measured:** how a cheap local reviewer's verdicts agree with a stronger reviewer's on the same work, over four calibration versions (v1 to v4), plus an offline smoke run of the review client against a fake local server.
- **Command (from `evidence/cascade/`):** `make eval`. It recomputes the table from `data/replays.json` (49 scrubbed rows per version, see `SCRUB.md`), then runs the client against a loopback fake server.
- **Figure (re-run, exit code 0; same as recorded):**
  - v1 catch 0.71, false alarm 0.53, precision 0.68
  - v2 catch 0.03, false alarm 0.00, precision 1.00
  - v3 catch 0.50, false alarm 0.42, precision 0.65
  - v4 catch 0.40, false alarm 0.28, precision 0.71

  Rows scored per version (think=false rows with an `alcor` verdict and no error), with the stronger reviewer's fails/passes: v1 39 of 49 (10 error rows excluded), 24 fails / 15 passes; v2 49 of 49, 30 / 19; v3 49 of 49, 30 / 19; v4 48 of 49 (1 error row excluded), 30 / 18.

  "Catch" is the share of the stronger reviewer's fails that the local reviewer also failed; "false alarm" is the share of its passes the local reviewer failed; "precision" is the share of the local reviewer's fails that the stronger reviewer also failed.
- **Limits:** the cascade was tuned on the same development replays it is scored on, so these numbers are not held-out; only the 49 non-thinking rows per version are kept; the fake-server step checks plumbing, not review quality.
