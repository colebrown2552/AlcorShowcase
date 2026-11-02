# Executable AlcorLang program corpus

This directory is the runnable corpus of example programs. It is deliberately small,
deterministic, and machine-checked.

`corpus.json` is the contract. Every `.alcor` file in this directory must be listed there with
either an exact output tape or an exact metered outcome. A program may be listed more than once,
with different `input` lines and a `name`, so one policy can be shown on several scenarios.

## Programs

| Program | Role |
| --- | --- |
| `runaway.alcor` | Adversarial complete-profile runaway; proves fuel stops it. |
| `quorum_gate.alcor` | Veto-first ALLOW / HOLD / REFUSE policy. |
| `capped_backoff.alcor` | Finite retry-delay ladder with a hard cap. |
| `publication_policy.alcor` | Prevents a failed publication from silently advancing its baseline. |
| `binding_lifecycle.alcor` | Enforces UNBOUND → CANDIDATE → VERIFIED → ACTIVE → STALE and pins prepared turns to a binding version. |
| `translate_request.alcor` | A v3 program (`ALCOR 3`): structured `FOR`/`IF` plus `.alcor.*` directives that only *describe* work. |
| `kernel.alcor` | An agent-loop round policy: 22 inputs in, one decision (`continue`, `pushback`, `accept`, `finalize`, `refuse`, ...) out. |
| `restraint.alcor` | An agent restraint policy: wait for a pending answer, never repeat the question or invent the answer. |
| `count.alcor` | Routes a counting question over long context to list-then-count. |

The policy programs are default-profile, effect-free finite DAGs. They make decisions but perform
no effects; the host retains execution authority. `kernel.alcor`, `restraint.alcor` and
`count.alcor` are unmodified programs from the system this repository was extracted from. They
read their request from the input tape, one value per line, and print a `schema=...` decision.

## Run one

```bash
python -m alcorlang run programs/quorum_gate.alcor
python -m alcorlang run programs/restraint.alcor --input-text $'alcor.restraint.request.v1\ntrue\nfalse\nfalse'
```

(In PowerShell, build the input with backtick-n: ``"alcor.restraint.request.v1`ntrue`nfalse`nfalse"``.)

## Verify the corpus

```bash
python -m pytest tests/test_program_corpus.py -q
```

The test loads the interpreter from the `alcorlang` package, checks that the manifest covers every
program, checks the exact output or metering receipt of every case, and confirms every policy
program remains default-profile and effect-free. Programs that contain effects (the directive
request) run against a gate that records nothing and writes nothing, so the test leaves no files
behind.
