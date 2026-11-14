# AlcorBench

A small benchmark of agentic coding tasks with hidden, executable checks. It measures how well
a language model works as a coding agent: it gets a short engineering request and a small
repository, uses tools to read, edit and run code, and is then graded by a check it never saw.

It was built to measure and improve Alcor, a locally hosted model used as a coding assistant.
It grades mechanically: the code works on inputs the agent was not shown, or it does not. That
gives labels that do not depend on a judge model's opinion, and they cost nothing to repeat.
The same harness runs against any OpenAI-compatible endpoint, local or hosted.

Python 3.10+, standard library only.

## Quickstart

```sh
# 1. Acceptance check of the harness: statistics, config, sandbox, outages and resume,
#    lanes, every task, scripted demo.
python3 -m alcorbench selfcheck

# 2. End-to-end demo with no model: a fake local endpoint replays canned tool calls
#    and the real tool-loop agent executes them. Written to a temp dir, labelled DEMO.
python3 -m alcorbench run --agent scripted --tasks examples/tasks --trials 1

# 3. A real model behind any OpenAI-compatible /v1/chat/completions endpoint
#    (vLLM, llama.cpp server, Ollama, or a hosted API).
export OPENAI_API_KEY=...            # omit for a local server without auth
python3 -m alcorbench run --agent toolloop \
    --base-url http://127.0.0.1:8000/v1 --model my-model --trials 3

# Several lanes of one server (one request in flight per model id): one worker each
python3 -m alcorbench run --agent toolloop --base-url http://127.0.0.1:8000/v1 \
    --model model-a,model-b --config my-scaffold.json

# Finish an interrupted run, or retry trials that hit an outage
python3 -m alcorbench run --resume results/<run> --base-url http://127.0.0.1:8000/v1

# Reports and paired comparisons of saved runs
python3 -m alcorbench report results/<run>
python3 -m alcorbench compare results/<run-a> results/<run-b>
```

Other commands: `list [--split train|holdout]`, `validate [TASK_DIR ...]`.
`scripts/ci_check.py` runs the import and hygiene checks, `selfcheck` and the CLI end to end.

Useful `run` options: `--split` (default `train`), `--task ID` (repeatable), `--trials`,
`--seed`, `--infra-passes` and `--infra-backoff` (see below). The API key is read from the
variable named by `--api-key-env`; the key itself is never recorded.

## Agent config

The scaffold under test is one JSON object: `system_prompt` (or `system_prompt_file`, relative
to the config file), `temperature`, `max_tokens`, `max_turns`, `max_tool_calls`,
`command_timeout_s`, `wall_time_s` and `extra_body`. The built-in default is
`configs/default.json`, the only place the default prompt is written. `--config FILE`
overrides keys of the default, and the flags `--temperature`, `--max-tokens`, `--max-turns`,
`--max-tool-calls`, `--command-timeout`, `--wall-s`, `--system-prompt-file` and
`--extra-body JSON` override both. `extra_body` is merged into every request for
server-specific switches, for example `{"chat_template_kwargs": {"enable_thinking": false}}`
on a vLLM model with a thinking mode; it may not set `model`, `messages`, `tools` or `seed`,
which the harness owns.

Optional tool-loop options, all off by default (a key left out or set to its default is not
recorded, so a config that does not use them keeps its hash):

| Key | Default | Effect |
|---|---|---|
| `prefetch` | `false` | Before the first turn, appends a context packet to the brief: the detected test command, the work directory's file tree with sizes (200 entries at most), and the text of files the brief names by path and of small `test_*.py` files, cut at `prefetch_bytes` (default 12000) bytes with a marker where something was left out. Only regular files inside the work directory, never through a symlink. |
| `auto_test` | `false` | After each successful `write_file` or `replace_in_file`, runs the test command (shell timeout) and appends its result to that call's reply: pass, or fail with the last 40 lines. It stays one tool call; the row counts `auto_tests` and `auto_test_s`. |
| `finish_gate` | `false` | On `finish`, runs the test command; while it fails, the reply is `not finished: tests fail` with the tail and the trial goes on (later calls in that message are answered `not run`), at most `finish_gate_repairs` (default 2) times; then `finish` is accepted. A refusal on the last allowed turn ends the trial as `timeout`. The row counts `finish_gate_rejections`. |
| `batch_hint` | `false` | Adds one sentence to the system prompt: several tool calls may go in one turn and run in order, so read every needed file at once. |
| `test_command` | `null` | The test command. Unset, it is detected: a `tests/` directory or `test_*.py` files give `python3 -m unittest discover` (pytest only when the tests import it and it is installed); no tests, no command, and `auto_test` and `finish_gate` do nothing. Option values are type-checked when the config is resolved. |

Every toolloop row also records `tool_counts` (executed calls by name) and
`final_prompt_tokens` (the prompt size of the last turn). The manifest records the resolved config and the SHA-256
of its canonical JSON (sorted keys), so runs with the same scaffold share a hash whatever the
key order of the file.

## Agents

| Agent | What it is |
|---|---|
| `noop` | Changes nothing. Every check must fail on it. |
| `reference` | Applies the task's reference solution. Every check must pass on it. |
| `toolloop` | A minimal agent: one chat-completions loop with six tools (`run_shell`, `read_file`, `write_file`, `replace_in_file`, `list_files`, `finish`). Busy servers (429, 502, 503, 504) and dropped connections are retried a few times with exponential backoff, then the trial ends with status `error`. Each request carries a `seed` derived from the run seed, task and trial. A trial ends as `finished` only when the model calls `finish`; calls after `finish` in the same message are not run. A reply with text and no tool call gets one reminder to use the tools or call `finish`; a second one ends the trial with status `error` (it is still graded). `--model a,b` runs one worker per model id (lane), pulling trials from a shared queue; a trial's content and seed do not depend on which lane ran it, and the row records the lane. Lanes must serve the same weights: a run whose endpoint reported more than one model name is labelled MIXED MODELS and `compare` refuses it. |
| `command` | Any external agent CLI, given a template such as `my-agent --prompt-file {prompt_file} --cwd {workdir}`. It may write `{"input_tokens", "output_tokens", "turns", "tool_calls"}` as JSON to `{usage_file}`. Pass the variables it needs with `--pass-env NAME`. |
| `scripted` | The `toolloop` agent against a local fake endpoint that replays tool calls derived from the reference (and answers the first request with 503 to exercise the retry path). For CI and demos only. |

The tool loop is deliberately plain so a score measures the model; a scaffold change is a
different configuration and is reported as one.

## Isolation

- Only `fixture/` is copied into a fresh temporary work directory (with `git init` and one
  commit). `check.py` and `reference/` never enter it.
- The work directory has a neutral temporary name (no harness or task name in the path), and
  nothing in the environment points at the task folder.
- Files listed as `protected` are hashed before the agent runs, after it, and again after the
  check (which runs agent code); any change fails the trial, whatever the check says.
- Shell commands, external agents and checks run with cwd = the work directory, a minimal
  environment (no API keys or tokens from the parent; `HOME` is a scratch directory), and a
  timeout that kills the whole process group, including background children.
- File tools resolve symlinks and `..`, refuse any path outside the work directory, and refuse
  anything that is not a regular file (a FIFO would block).

This contains honest mistakes; it is not a security boundary. A shell command can still read
files elsewhere on the machine, so an agent you do not trust belongs in a container or VM.

## Task format

```
tasks/v1/<category>-<nn>-<slug>/
  task.json   id, title, category, family, difficulty (1-3), split (train|holdout),
              timeout_s (<= 60), protected (fixture paths), created, author
  brief.md    what the agent is told: a plain engineering request, at most 2,500 bytes
  fixture/    the starting repository: at most 8 files, 40 KB
  check.py    hidden acceptance check: exit 0 = pass, one short reason per failure
  reference/  files laid over the fixture that make the check pass (.delete lists removals)
```

Categories: bugfix, feature, refactor, testwriting, cli, multifile, data, config, parsing.
Checks test behaviour, not text: they run the agent's code in a subprocess with a timeout, on
inputs the brief did not list, including an edge case. A check finds its own folder with
`Path(__file__).resolve().parent` and gives every subprocess an explicit minimal environment;
`validate` rejects a check that inherits or copies `os.environ`. `validate` lints every task and
requires that the untouched fixture fails and the reference passes (twice). Tasks that share a
`family` share a split, so the holdout set is not near-duplicates of training tasks.
`examples/tasks/` holds two tiny tasks used by the selfcheck and the demo; they are not part
of any versioned task set. New tasks start in `tasks/candidate/`.

## Results and statistics

A run directory holds `manifest.json` (agent, lanes, endpoint options, the resolved config
and its hash, the model id the endpoint reported, date, code commit, Python version, a content
hash of the task set, trials, seed, and whether the run is complete) and `trials.jsonl` (one
row per task trial: pass/fail, check output tail, protected-file violations, agent status,
turns, tool calls, tokens, wall time, lane, seed). Transcripts sit beside them.
`trials.jsonl` is append-only: a retried trial adds a row, and the latest row for a
(task, trial) pair is the one that counts.

**Infrastructure errors.** Only three things before the model's first turn count: no
connection, HTTP 429/502/503/504 after the client's retries, and a first request that timed
out before any byte of the reply arrived. Such a trial was never attempted: it is recorded with
`infra_error: true` and the reason in `error`, is not checked, and is left out of every rate.
A 4xx on the first request (an unknown model id, a rejected key or `extra_body`) would hit every
trial, so it aborts the run with a message; finished trials are kept for `--resume`. Anything
else is a real failure and is graded with the error recorded: another 5xx, a 200 without an
assistant message, a reply that started and then overran, any failure after the first turn,
running out of turns or of wall time. At the end of a run, `run` makes `--infra-passes` extra passes
(default 2) over infra-failed trials, waiting `--infra-backoff` seconds (default 30, doubling)
before each. `run --resume RUN_DIR` reuses the run's own manifest and runs only trials that
are missing or still infra-failed; because the manifest keeps no host name (below), a toolloop
resume needs `--base-url` again. A run with unresolved infrastructure errors or missing trials
is marked incomplete in the manifest and the report, and every pass rate is printed beside a
**floor**: the rate if each of those trials had failed. A model that never answers its first
request within the request timeout stays infra-failed, so its run stays incomplete.

The manifest stores the endpoint as scheme and port only, with the host replaced by `local`
(loopback) or `redacted`, so published results carry no private host names.

- **Pass rate** is the mean over tasks of each task's pass fraction across trials. Its 95% CI
  is a percentile bootstrap that resamples tasks (10,000 resamples, fixed seed, tasks sorted by
  id first so row order cannot change it), because trials of the same task are not
  independent. Intervals are printed only for slices of 10 or more tasks; below that a
  bootstrap or Wilson interval says little, so the report shows the rate and n alone.
- **First try** is the share of tasks passed on trial 0 (among tasks whose trial 0 was
  graded), with a Wilson 95% interval.
- **Paired comparison** of two runs uses only the tasks graded on every trial in both runs
  (the report says how many shared tasks it dropped): the mean per-task difference in pass
  fraction with a task-bootstrap 95% CI (from 10 paired tasks up), and an exact two-sided sign
  test over tasks (ties dropped).
- **Flip rate** is the share of repeated tasks whose trials disagree: a direct read on how much
  of a score is noise.
- `report` breaks these down by split and category with median wall time, mean tool calls and
  mean tokens. `selfcheck` checks the statistics against hand-computed answers.

## Honesty rules

- Holdout tasks are run only to confirm a change that already won on train. Every holdout
  evaluation is listed in `results/HOLDOUT-LOG.md` with its date and outcome, including losses.
  The CLI refuses a model run on holdout tasks without `--confirm-holdout`.
- A result names the model, quantisation, scaffold, date, trials and CI. A result on fewer than
  20 tasks or fewer than 3 trials is labelled preliminary; `report` adds the label itself.
- Scripted and oracle runs are never written under `results/`; the CLI refuses it.
- The tasks were written with AI assistance under the owner's direction.

## Limits

- Few tasks: tens, not thousands. Intervals are wide and small differences will not show.
- Python only, small repositories, single-session tasks.
- One author kind: every task comes from the same AI assistant, so the set shares its blind
  spots and may suit models trained on similar text.
- The checks are as good as their inputs; a passing check is strong evidence, not proof.
- The `command` agent cannot tell an external agent's outage from a failure, so its
  trials are always graded.

## Results

A baseline and one experiment so far, on the train split only. Holdout has not been run: it is touched only to
confirm a change that already won on train (see `results/HOLDOUT-LOG.md`).

| Run | Model | Scaffold | Tasks | Trials | Pass rate | 95% CI | First try | Flip rate | Median seconds |
|---|---|---|---|---|---|---|---|---|---|
| `results/2026-11-13-baseline-train` | `Qwen3.6-35B-A3B`, `NVFP4`, served by vLLM `0.28.0` on one machine | `toolloop`, `configs/default.json` | 24 (train) | 3 | 62.5% | 45.8% to 77.8% | 15 of 24 | 33.3% | 53.4 |

Pass rate is the mean over tasks of each task's pass fraction; the interval is a task-level
bootstrap. First try counts tasks passed on their first trial. Flip rate is the share of tasks
whose trials disagreed with one another, at temperature `0`: the same configuration does not
give the same answer twice, which is why every comparison here is paired over tasks and
repeated. With this few tasks only a large difference between two configurations can be told
apart from noise. Every figure above has a row in `results/CLAIMS.md` with its command and source.

### Turn-saver experiment

Four arms each turned on tool-loop options from "Agent config" above, with the same model, tasks,
trials and seed as the baseline (24 train tasks, 3 trials; arms C and D ran on a different lane
of the same server). No option is shown to change the pass rate at this sample size: every
paired interval includes zero. Prefetch and auto-test do cut turns and time per trial (median
turns 12 to 8 with all options on). Arm D, whose one-sentence hint changed nothing measurable
in how the model batched calls, moved the pass rate as much as the strongest arm: a rough read
on how large the noise is.

| Arm | Option(s) on | Pass rate (95% CI) | Paired diff vs baseline (95% CI) | Median turns | Median seconds |
|---|---|---|---|---|---|
| Baseline | none | 62.5% (45.8% to 77.8%) | - | 12 | 53.4 |
| A | all four | 72.2% (55.6% to 87.5%) | +9.7 pts (-2.8 to +23.6) | 8 | 35.7 |
| B | `prefetch` | 66.7% (51.4% to 81.9%) | +4.2 pts (-6.9 to +16.7) | 10 | 37.7 |
| C | `auto_test`, `finish_gate` | 68.1% (51.4% to 83.3%) | +5.6 pts (-6.9 to +18.1) | 10 | 41.2 |
| D (control) | `batch_hint` | 72.2% (59.7% to 84.7%) | +9.7 pts (-2.8 to +22.2) | 12 | 45.4 |

Paired differences are per-task, against the baseline, with a task-bootstrap interval. Turns
and seconds come from one run per arm and have no interval. The full write-up, including tool
counts, tokens and what changed per task, is `results/TURNS-EXPERIMENT.md`; every figure here
has a row in `results/CLAIMS.md`.
