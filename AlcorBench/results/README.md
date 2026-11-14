# Saved runs

Each directory is one complete, non-demo run on the train split (24 tasks, 3 trials, seed 0):

| Run | What it is |
|---|---|
| `2026-11-13-baseline-train` | Train baseline, `configs/default.json` |
| `2026-11-14-turns-all` | Turn-saver arm A, `configs/experiments/turns-all.json` |
| `2026-11-14-turns-prefetch` | Turn-saver arm B, `configs/experiments/turns-prefetch.json` |
| `2026-11-14-turns-tests` | Turn-saver arm C, `configs/experiments/turns-tests.json` |
| `2026-11-14-turns-batch` | Turn-saver arm D, `configs/experiments/turns-batch.json` |

A run directory holds `manifest.json`, `trials.jsonl` and `summary.json`. The baseline's
`summary.json` was written with the run; the four arms' files were computed afterwards from
their saved `trials.jsonl` with `alcorbench.stats` (the same code as `report` and `compare`)
and also carry the paired comparison with the baseline. Every number quoted elsewhere has a
row in `CLAIMS.md`. `TURNS-EXPERIMENT.md` is the write-up of the turn-saver experiment and
`HOLDOUT-LOG.md` lists holdout evaluations (none so far).

**Transcripts are kept privately.** The full per-trial transcripts (about 9 MB) are not in this
copy: the model's shell commands ran on the author's machine, and at least one of them listed
directories outside the task's work directory. `trials.jsonl` keeps each trial's
`transcript_path` as recorded. Everything in `CLAIMS.md` is computed from `trials.jsonl`
and needs no transcript. The rows of `TURNS-EXPERIMENT.md` that count the baseline's tool
calls by name, re-reads of a path and final context were read from transcripts, so
`scripts/turns_table.py` prints `n/a` for them here.

Lane names such as `alcor-brain-slot2` and `alcor-brain-arc` in the manifests and rows are
model ids on the author's local endpoint (all lanes reported the same served model); the
endpoint itself is recorded as `http://local:8877`.
