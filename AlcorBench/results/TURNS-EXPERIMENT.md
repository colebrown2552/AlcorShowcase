# Turn-saver experiment (train split)

Four tool-loop options, each off by default (see README, "Agent config"), measured against the
train baseline `results/2026-11-13-baseline-train`. All runs: `toolloop`, 24 train tasks,
3 trials, seed 0, `configs/default.json` plus one experiment file, local endpoint. Holdout was
not run.

| Arm | Config (sha256 prefix) | Run | Lane | Time (UTC) |
|---|---|---|---|---|
| Baseline | `configs/default.json` (`57117e80`) | `results/2026-11-13-baseline-train` | `alcor-brain-slot2` | 11-13 21:44 to 23:03 |
| A: all four | `configs/experiments/turns-all.json` (`a3d1a587`) | `results/2026-11-14-turns-all` | `alcor-brain-slot2` | 00:19 to 01:29 |
| B: prefetch | `configs/experiments/turns-prefetch.json` (`9eb4b85e`) | `results/2026-11-14-turns-prefetch` | `alcor-brain-slot2` | 03:00 to 04:06 |
| C: auto_test + finish_gate | `configs/experiments/turns-tests.json` (`924c8c1c`) | `results/2026-11-14-turns-tests` | `alcor-brain-arc` | 04:27 to 05:25 |
| D: batch_hint | `configs/experiments/turns-batch.json` (`a1dad76e`) | `results/2026-11-14-turns-batch` | `alcor-brain-arc` | 05:25 to 06:44 |

Every run is complete (72 graded trials, no unresolved infrastructure errors). Every run's
endpoint reported the same model name (`alcor-brain-slot1`) whatever lane it was sent to.
Arms C and D ran on lane `arc` instead of `slot2` because slot2 was needed for other work. The
lanes are said to share one backend, and the reported name agrees, but the lane did change
between arms, so it is one more difference besides the option.
Two runs were stopped and not kept: a first start of arm A (3 trials, stopped to fix review
findings before measuring) and a partial arm C on slot2 (23 trials, stopped when slot2 was
needed elsewhere; `--resume` cannot change the lane). Neither is used here. The code for every
arm is commit `591e933`. Manifests show `git_dirty: true` only because each run's own output
directory was untracked while it ran, as in the baseline.

## Results

Produced by `python3 scripts/turns_table.py results/2026-11-13-baseline-train results/2026-11-14-turns-{all,prefetch,tests,batch}`.
The paired line is the computation `python3 -m alcorbench compare <arm> results/2026-11-13-baseline-train`
uses (all 24 tasks paired in every case; the figures match its output).
Tool calls are executed calls, summed over the 72 trials. Final context is the prompt size
of the last turn.

| | `2026-11-13-baseline-train` | `2026-11-14-turns-all` | `2026-11-14-turns-prefetch` | `2026-11-14-turns-tests` | `2026-11-14-turns-batch` |
|---|---|---|---|---|---|
| Graded trials (complete run) | 72 (yes) | 72 (yes) | 72 (yes) | 72 (yes) | 72 (yes) |
| Pass rate (95% CI) | 62.5% (45.8% to 77.8%) | 72.2% (55.6% to 87.5%) | 66.7% (51.4% to 81.9%) | 68.1% (51.4% to 83.3%) | 72.2% (59.7% to 84.7%) |
| Paired diff vs baseline (95% CI) | - | +9.7 pts (-2.8 to +23.6) | +4.2 pts (-6.9 to +16.7) | +5.6 pts (-6.9 to +18.1) | +9.7 pts (-2.8 to +22.2) |
| Tasks better / worse / tied; sign p | - | 5 / 2 / 17; 0.453 | 5 / 5 / 14; 1.000 | 6 / 4 / 14; 0.754 | 8 / 3 / 13; 0.227 |
| First-try passes | 15 of 24 | 16 of 24 | 17 of 24 | 16 of 24 | 19 of 24 |
| Flip rate | 33.3% | 16.7% | 33.3% | 29.2% | 45.8% |
| Turns: median / mean | 12 / 12.7 | 8 / 9.4 | 10 / 10.4 | 10 / 10.8 | 12 / 12.9 |
| Tool calls: total (per trial) | 1124 (15.6) | 825 (11.5) | 843 (11.7) | 997 (13.8) | 1156 (16.1) |
| &nbsp; run_shell | 523 | 363 | 409 | 389 | 543 |
| &nbsp; read_file | 289 | 221 | 183 | 308 | 292 |
| &nbsp; replace_in_file | 115 | 79 | 89 | 105 | 102 |
| &nbsp; write_file | 78 | 91 | 92 | 76 | 95 |
| &nbsp; list_files | 48 | 1 | 0 | 48 | 54 |
| &nbsp; finish | 71 | 70 | 70 | 71 | 70 |
| &nbsp; read_file re-reads of a path | 38 | 42 | 30 | 59 | 43 |
| Median seconds per trial | 53.4 | 35.7 | 37.7 | 41.2 | 45.4 |
| Mean input / output tokens per trial | 49,456 / 2,399 | 47,080 / 2,257 | 47,964 / 2,284 | 40,026 / 2,180 | 52,313 / 2,616 |
| Median input tokens per trial | 43,078 | 33,914 | 40,139 | 35,748 | 40,258 |
| Final context, median prompt tokens | 5,198 | 5,466 | 5,302 | 5,306 | 5,147 |
| Auto-test runs (total seconds) | 0 (0s) | 127 (10s) | 0 (0s) | 143 (10s) | 0 (0s) |
| Finish-gate rejections | 0 | 0 | 0 | 0 | 0 |
| Trials ended by finish | 71 of 72 | 70 of 72 | 70 of 72 | 71 of 72 | 70 of 72 |

Tasks that changed in `2026-11-14-turns-all` (passes of 3, baseline -> arm):
- config-02-shoebox-env-overrides: 2 -> 0
- bugfix-04-shortlink-stale-cache: 1 -> 0
- parsing-02-eventlog-kv-tokenizer: 0 -> 1
- config-03-labelrelay-config-validation: 1 -> 3
- feature-04-template-filters: 1 -> 3
- refactor-02-inventory-global-state: 1 -> 3
- feature-02-toc-depth-and-dedupe: 0 -> 3

Tasks that changed in `2026-11-14-turns-prefetch` (passes of 3, baseline -> arm):
- config-01-sitebuild-settings-migration: 3 -> 2
- feature-03-bytesize-parse: 3 -> 2
- bugfix-04-shortlink-stale-cache: 1 -> 0
- config-02-shoebox-env-overrides: 2 -> 1
- parsing-01-cronlite-duration-parser: 1 -> 0
- data-03-newsletter-subscriber-dedupe: 0 -> 1
- feature-04-template-filters: 1 -> 2
- feature-02-toc-depth-and-dedupe: 0 -> 2
- refactor-02-inventory-global-state: 1 -> 3
- testwriting-01-sms-splitter: 1 -> 3

Tasks that changed in `2026-11-14-turns-tests` (passes of 3, baseline -> arm):
- config-02-shoebox-env-overrides: 2 -> 0
- bugfix-01-logrotate-backup-count: 3 -> 2
- config-03-labelrelay-config-validation: 1 -> 0
- parsing-01-cronlite-duration-parser: 1 -> 0
- feature-02-toc-depth-and-dedupe: 0 -> 1
- multifile-01-report-markdown-exporter: 1 -> 2
- parsing-02-eventlog-kv-tokenizer: 0 -> 1
- data-03-newsletter-subscriber-dedupe: 0 -> 2
- feature-04-template-filters: 1 -> 3
- refactor-02-inventory-global-state: 1 -> 3

Tasks that changed in `2026-11-14-turns-batch` (passes of 3, baseline -> arm):
- bugfix-01-logrotate-backup-count: 3 -> 1
- refactor-01-recipe-quantity-formatter: 3 -> 2
- parsing-01-cronlite-duration-parser: 1 -> 0
- data-03-newsletter-subscriber-dedupe: 0 -> 1
- multifile-01-report-markdown-exporter: 1 -> 2
- parsing-02-eventlog-kv-tokenizer: 0 -> 1
- refactor-02-inventory-global-state: 1 -> 2
- config-02-shoebox-env-overrides: 2 -> 3
- cli-02-dotenv-unset: 0 -> 2
- feature-02-toc-depth-and-dedupe: 0 -> 2
- feature-04-template-filters: 1 -> 3

Turns that carried more than one tool call: baseline 94 of 916 (10.3%), A 76 of 676 (11.2%),
B 45 of 749 (6.0%), C 102 of 777 (13.1%), D 95 of 931 (10.2%).

## What this can and cannot show

- **No arm is shown to improve the pass rate.** Every paired 95% CI includes zero: A +9.7 points
  (-2.8 to +23.6), B +4.2 (-6.9 to +16.7), C +5.6 (-6.9 to +18.1), D +9.7 (-2.8 to +22.2). No sign
  test comes near significance (smallest p = 0.23, arm D). By the rule set for this experiment,
  none of these is an improvement.
- **The noise is about as large as the effects.** With 24 tasks and 3 trials, one task moving by
  one pass changes the rate by 1.4 points, and the baseline's flip rate is 33%. Two direct checks:
  - Arm D changes only one sentence of the prompt and did not change the model's batching
    (10.2% against 10.3%). Yet it "gained" exactly as much as arm A, with 11 tasks changing outcome.
  - Six tasks have no test files (config-01/02/03, data-01/02, parsing-02). In arm C every
    option is a no-op on them, so they rerun the baseline's exact prompt and seeds. Still, 3 of
    the 6 changed outcome (config-02 2 -> 0, config-03 1 -> 0, parsing-02 0 -> 1), and their turn
    counts differ too. Temperature 0 and a fixed seed do not make this server repeat itself.
- **Some tasks rose in every arm:** feature-02, feature-04 and refactor-02. That fits the
  baseline having been unlucky on them better than it fits any one option helping, since the
  same gains appear under the batch hint, which changed nothing measurable.
- **Cost per trial is where the options show up**, but each arm has one run and no interval.
  The figures are descriptive:
  - **A (all four):** median turns 12 -> 8, tool calls 1,124 -> 825, median seconds 53.4 -> 35.7,
    median input tokens per trial 43,078 -> 33,914.
  - **B (prefetch):** median turns 10. `list_files` 48 -> 0, `read_file` 289 -> 183, median
    seconds 37.7.
  - **C (auto_test + gate):** median turns 10, `run_shell` 523 -> 389, mean input tokens
    49,456 -> 40,026 (the lowest).
  - **D (batch_hint):** turns, tool calls and time are all about baseline.
  - The turn savings look additive: B and C each save about 2 median turns and A saves 4. This
    is consistent with prefetch replacing the exploration calls and auto-test replacing the
    "run the tests" shell calls. A's cost reduction is large next to D's no-change, which serves
    as a rough control, but one run per arm is not a measurement of its spread.
- Mean input tokens per trial fell less than the turns did (A: 49,456 -> 47,080), because the
  packet makes every prompt longer. The final context barely changed (about 5,100-5,500 tokens
  in every arm).
- **Flip rates:** baseline 33.3%, A 16.7%, B 33.3%, C 29.2%, D 45.8%. A flip rate from one
  3-trial run moves this much on its own; A's low figure is not evidence of stability.
- **Server errors mid-trial are graded as failures**, as the harness rules say. Trials ending on
  an HTTP 500 (`EngineCore encountered an issue`) or 503 after the first turn: baseline 1, A 1,
  B 2, C 1, D 2. parsing-01, trial 0, hits the same 500 at turn 4 in the baseline and arm A.

## Surprises

- **The finish gate never fired:** 0 rejections in 144 trials with it on (A and C). The model
  does not call finish while the visible tests fail, so the gate cost nothing and did nothing
  here. The failures that remain are hidden-check failures with green visible tests.
- **Prefetch did not stop reads of files it had already shown.** In arm A, 200 of the 221
  `read_file` calls were for a file whose full text was in the packet. The saving came from
  dropping `list_files` and exploratory shell calls.
- **The batch hint did nothing to batching:** about 10% of turns had several calls with or
  without it. Arm B batched less (6.0%), plausibly because the files it would have read
  together were already in the prompt.
- **The model sometimes re-reads more with auto-test on:** re-reads of the same path went from
  38 to 59 in arm C.
- Auto-test is cheap: 127 and 143 runs took 10 seconds in total in each arm.

## Unfinished

- A difference of the size seen here (about 5-10 points) needs far more trials, or more tasks,
  than 24 x 3 to resolve. A follow-up that wants a pass-rate answer should run more trials of
  the strongest candidate (A) and of the baseline, ideally interleaved in time on one lane.
- The cost figures (turns, seconds, tokens) come from one run per arm. Repeat runs would put
  an interval on them.
- `scripts/ci_check.py` now fails its hygiene step, and I left it failing on purpose. Three rows of
  arm C's `trials.jsonl` carry the hidden check's output for cli-02. That output repeats the
  task's own sample values (`https://api.example.test`, `redis://cache:6379`, from that task's
  `check.py`), and the hygiene rule allows no host but loopback in result metadata. These hosts
  are task data, not a leak. Neither the evidence nor the check was changed to make it pass. The
  likely fix is to let `check_output_tail` name hosts that occur in task files, as transcripts
  already may; it needs a separate decision. `selfcheck` and the import and CLI steps pass.

Update, 2026-11-14: the hygiene rule now lets run metadata name hosts that occur in task files
(AlcorBench source commit `793727f`), and `scripts/ci_check.py` passes with every run above
unchanged. The public copy of this repository leaves out the transcripts (see
`results/README.md`), so the transcript-derived baseline rows of the table above print `n/a`
when the command is rerun there.
