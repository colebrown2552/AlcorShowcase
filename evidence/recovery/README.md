# recovery

This folder holds a sandboxed fault-injection suite
for interrupted work: disposable workers, a fake effect receiver and a sandboxed task ledger. Layout: `fault_matrix.json` (the frozen 10-family matrix), `fault_suite.py` (the suite) and, once a run is recorded, `results/<run-id>/` (manifest, trials, receiver log).

Note: re-running the real-seam families needs a non-public kernel module (`AlcorSystem/tasks.py`); the raw trials are included in `results/`.

## Run the suite

```
python3 -B fault_suite.py [--quick] --seed S --workdir DIR [--receiver URL] [--trials N] [--inject-duplicate-fault]
```

- `--workdir DIR` must be an existing empty directory; the suite writes only there (`tasks/` sandbox ledger, `trials.jsonl`, `receiver.jsonl`, `manifest.json`, a copy of `fault_matrix.json`).
- `--seed S` fixes trial ids and random choices. `ALCOR_ROOT` must point at the tree that holds `AlcorSystem/tasks.py`.
- `--quick` runs 3 trials per family with a 0.3 s lease; the full run is 30 per family (300) with a 1 s lease. `--trials N` overrides the per-family count.
- `--receiver URL` is the base URL of the effect receiver (`POST /effect`, `GET /effects?logical_task_id=X`); without it the suite starts its own loopback receiver.
- `--inject-duplicate-fault` makes the controller blindly re-execute effects in two families, so the receiver holds extra effects and the manifest shows them as duplicates.

Quick: `python3 -B fault_suite.py --quick --seed 20261108 --workdir DIR`. Full: `python3 -B fault_suite.py --seed 20261108 --workdir DIR`.
