# Claims

Every number quoted outside this repository comes from a row here. Each row gives the command
that produced it, the number of tasks it rests on, its date and the saved file that holds it.
A figure on fewer than 20 tasks or fewer than 3 trials is marked PRELIMINARY in its claim text.

The train baseline was run on `Qwen3.6-35B-A3B` (`NVFP4`) served by vLLM `0.28.0`, with the `toolloop`
agent and `configs/default.json`. The model id in the command is the name of a lane on the
author's local endpoint; substitute your own endpoint and model id to reproduce.

| claim | value | command | n | date | source |
|---|---|---|---|---|---|
| Train baseline: tasks | 24 | `python3 -m alcorbench run --agent toolloop --split train --trials 3 --base-url http://127.0.0.1:8877/v1 --model alcor-brain-slot2` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/summary.json` |
| Train baseline: trials per task | 3 | `python3 -m alcorbench run --agent toolloop --split train --trials 3 --base-url http://127.0.0.1:8877/v1 --model alcor-brain-slot2` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/summary.json` |
| Train baseline: pass rate, percent | 62.5 | `python3 -m alcorbench report results/2026-11-13-baseline-train` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/summary.json` |
| Train baseline: pass rate 95% CI low, percent | 45.8 | `python3 -m alcorbench report results/2026-11-13-baseline-train` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/summary.json` |
| Train baseline: pass rate 95% CI high, percent | 77.8 | `python3 -m alcorbench report results/2026-11-13-baseline-train` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/summary.json` |
| Train baseline: tasks passed on the first trial | 15 | `python3 -m alcorbench report results/2026-11-13-baseline-train` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/summary.json` |
| Train baseline: flip rate, percent | 33.3 | `python3 -m alcorbench report results/2026-11-13-baseline-train` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/summary.json` |
| Train baseline: median seconds per trial | 53.4 | `python3 -m alcorbench report results/2026-11-13-baseline-train` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/summary.json` |
| Train baseline: median turns per trial | 12 | `python3 scripts/turns_table.py results/2026-11-13-baseline-train results/2026-11-14-turns-{all,prefetch,tests,batch}` | 24 | 2026-11-13 | `results/2026-11-13-baseline-train/trials.jsonl` |
| Turn-saver arm A (all four options): pass rate, percent | 72.2 | `python3 -m alcorbench report results/2026-11-14-turns-all` | 24 | 2026-11-14 | `results/2026-11-14-turns-all/summary.json` |
| Turn-saver arm A (all four options): pass rate 95% CI low, percent | 55.6 | `python3 -m alcorbench report results/2026-11-14-turns-all` | 24 | 2026-11-14 | `results/2026-11-14-turns-all/summary.json` |
| Turn-saver arm A (all four options): pass rate 95% CI high, percent | 87.5 | `python3 -m alcorbench report results/2026-11-14-turns-all` | 24 | 2026-11-14 | `results/2026-11-14-turns-all/summary.json` |
| Turn-saver arm A (all four options): paired difference vs train baseline, points | +9.7 | `python3 -m alcorbench compare results/2026-11-14-turns-all results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-all/summary.json` |
| Turn-saver arm A (all four options): paired difference 95% CI low, points | -2.8 | `python3 -m alcorbench compare results/2026-11-14-turns-all results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-all/summary.json` |
| Turn-saver arm A (all four options): paired difference 95% CI high, points | +23.6 | `python3 -m alcorbench compare results/2026-11-14-turns-all results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-all/summary.json` |
| Turn-saver arm A (all four options): median turns per trial | 8 | `python3 scripts/turns_table.py results/2026-11-13-baseline-train results/2026-11-14-turns-{all,prefetch,tests,batch}` | 24 | 2026-11-14 | `results/2026-11-14-turns-all/summary.json` |
| Turn-saver arm A (all four options): median seconds per trial | 35.7 | `python3 -m alcorbench report results/2026-11-14-turns-all` | 24 | 2026-11-14 | `results/2026-11-14-turns-all/summary.json` |
| Turn-saver arm B (prefetch): pass rate, percent | 66.7 | `python3 -m alcorbench report results/2026-11-14-turns-prefetch` | 24 | 2026-11-14 | `results/2026-11-14-turns-prefetch/summary.json` |
| Turn-saver arm B (prefetch): pass rate 95% CI low, percent | 51.4 | `python3 -m alcorbench report results/2026-11-14-turns-prefetch` | 24 | 2026-11-14 | `results/2026-11-14-turns-prefetch/summary.json` |
| Turn-saver arm B (prefetch): pass rate 95% CI high, percent | 81.9 | `python3 -m alcorbench report results/2026-11-14-turns-prefetch` | 24 | 2026-11-14 | `results/2026-11-14-turns-prefetch/summary.json` |
| Turn-saver arm B (prefetch): paired difference vs train baseline, points | +4.2 | `python3 -m alcorbench compare results/2026-11-14-turns-prefetch results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-prefetch/summary.json` |
| Turn-saver arm B (prefetch): paired difference 95% CI low, points | -6.9 | `python3 -m alcorbench compare results/2026-11-14-turns-prefetch results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-prefetch/summary.json` |
| Turn-saver arm B (prefetch): paired difference 95% CI high, points | +16.7 | `python3 -m alcorbench compare results/2026-11-14-turns-prefetch results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-prefetch/summary.json` |
| Turn-saver arm B (prefetch): median turns per trial | 10 | `python3 scripts/turns_table.py results/2026-11-13-baseline-train results/2026-11-14-turns-{all,prefetch,tests,batch}` | 24 | 2026-11-14 | `results/2026-11-14-turns-prefetch/summary.json` |
| Turn-saver arm B (prefetch): median seconds per trial | 37.7 | `python3 -m alcorbench report results/2026-11-14-turns-prefetch` | 24 | 2026-11-14 | `results/2026-11-14-turns-prefetch/summary.json` |
| Turn-saver arm C (auto_test + finish_gate): pass rate, percent | 68.1 | `python3 -m alcorbench report results/2026-11-14-turns-tests` | 24 | 2026-11-14 | `results/2026-11-14-turns-tests/summary.json` |
| Turn-saver arm C (auto_test + finish_gate): pass rate 95% CI low, percent | 51.4 | `python3 -m alcorbench report results/2026-11-14-turns-tests` | 24 | 2026-11-14 | `results/2026-11-14-turns-tests/summary.json` |
| Turn-saver arm C (auto_test + finish_gate): pass rate 95% CI high, percent | 83.3 | `python3 -m alcorbench report results/2026-11-14-turns-tests` | 24 | 2026-11-14 | `results/2026-11-14-turns-tests/summary.json` |
| Turn-saver arm C (auto_test + finish_gate): paired difference vs train baseline, points | +5.6 | `python3 -m alcorbench compare results/2026-11-14-turns-tests results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-tests/summary.json` |
| Turn-saver arm C (auto_test + finish_gate): paired difference 95% CI low, points | -6.9 | `python3 -m alcorbench compare results/2026-11-14-turns-tests results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-tests/summary.json` |
| Turn-saver arm C (auto_test + finish_gate): paired difference 95% CI high, points | +18.1 | `python3 -m alcorbench compare results/2026-11-14-turns-tests results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-tests/summary.json` |
| Turn-saver arm C (auto_test + finish_gate): median turns per trial | 10 | `python3 scripts/turns_table.py results/2026-11-13-baseline-train results/2026-11-14-turns-{all,prefetch,tests,batch}` | 24 | 2026-11-14 | `results/2026-11-14-turns-tests/summary.json` |
| Turn-saver arm C (auto_test + finish_gate): median seconds per trial | 41.2 | `python3 -m alcorbench report results/2026-11-14-turns-tests` | 24 | 2026-11-14 | `results/2026-11-14-turns-tests/summary.json` |
| Turn-saver arm D (batch_hint, control): pass rate, percent | 72.2 | `python3 -m alcorbench report results/2026-11-14-turns-batch` | 24 | 2026-11-14 | `results/2026-11-14-turns-batch/summary.json` |
| Turn-saver arm D (batch_hint, control): pass rate 95% CI low, percent | 59.7 | `python3 -m alcorbench report results/2026-11-14-turns-batch` | 24 | 2026-11-14 | `results/2026-11-14-turns-batch/summary.json` |
| Turn-saver arm D (batch_hint, control): pass rate 95% CI high, percent | 84.7 | `python3 -m alcorbench report results/2026-11-14-turns-batch` | 24 | 2026-11-14 | `results/2026-11-14-turns-batch/summary.json` |
| Turn-saver arm D (batch_hint, control): paired difference vs train baseline, points | +9.7 | `python3 -m alcorbench compare results/2026-11-14-turns-batch results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-batch/summary.json` |
| Turn-saver arm D (batch_hint, control): paired difference 95% CI low, points | -2.8 | `python3 -m alcorbench compare results/2026-11-14-turns-batch results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-batch/summary.json` |
| Turn-saver arm D (batch_hint, control): paired difference 95% CI high, points | +22.2 | `python3 -m alcorbench compare results/2026-11-14-turns-batch results/2026-11-13-baseline-train` | 24 | 2026-11-14 | `results/2026-11-14-turns-batch/summary.json` |
| Turn-saver arm D (batch_hint, control): median turns per trial | 12 | `python3 scripts/turns_table.py results/2026-11-13-baseline-train results/2026-11-14-turns-{all,prefetch,tests,batch}` | 24 | 2026-11-14 | `results/2026-11-14-turns-batch/summary.json` |
| Turn-saver arm D (batch_hint, control): median seconds per trial | 45.4 | `python3 -m alcorbench report results/2026-11-14-turns-batch` | 24 | 2026-11-14 | `results/2026-11-14-turns-batch/summary.json` |
