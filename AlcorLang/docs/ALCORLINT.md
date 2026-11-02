# AlcorLint v1

**Schema:** `alcor.lint.v1`

AlcorLint is the read-only diagnostic layer over AlcorLang. The language implementation stays
authoritative for parsing, static checks, interpretation and lowering. AlcorLint never runs the
program, installs a gate adapter, performs effects, rewrites source, invokes a model, or
accesses the network.

## Commands

```bash
python -m alcorlang lint programs/quorum_gate.alcor
python -m alcorlang lint programs/runaway.alcor --format json
python -m alcorlang lint programs/runaway.alcor --strict        # warnings fail too
python -m alcorlang lint generated.alcor --disable 'source/*'   # switch off a family
python -m alcorlang audit programs                              # every .alcor under a directory
```

`lint -` reads standard input. It has no include root unless the caller passes `--base-dir`:
source text alone never grants filesystem access. Exit status is 0 when there are no errors
(and, with `--strict`, no warnings) and 1 otherwise.

## Diagnostic contract

Every finding has a stable rule id, a severity, a document path, and a 1-indexed range. `ok`
means no error diagnostics; `clean` means no diagnostics at all. Warnings therefore remain
non-blocking unless `--strict` is selected. A consumer must show warnings, not only `ok`.

`parse/*` findings cannot be disabled: a program the canonical parser rejects is never "clean".

## Rule ids

| Rule | Severity | Meaning |
| --- | --- | --- |
| `parse/error` | error | The canonical parser or a static check rejected the program. |
| `parse/internal-error` | error | The parser failed outside its declared rejection type. |
| `source/invalid-utf8` | error | The file is not valid UTF-8. |
| `source/unreadable` | error | The file could not be read. |
| `source/trailing-whitespace` | warning | Spaces or tabs after the last token. |
| `source/tab-indentation` | warning | A leading tab. |
| `source/missing-final-newline` | warning | No newline at end of file. |
| `profile/unsigned-complete` | warning | A `complete` program with no authority is refused by `run()`. |
| `profile/conformance-authority` | warning | `authority=conformance` is sandbox-only. |
| `profile/unbounded-fuel` | warning | `fuel=0` declares an unbounded computation. |
| `vocabulary/role-check-skipped` | warning | The active table has no verb/object roles, so they were not enforced. |
| `flow/unreachable-program` | warning | A named block no `CALL` can reach from the unnamed entry block. |
| `effect/in-loop` | warning | An embedded effect inside a loop: every iteration is a separate gated attempt. |
| `project/case-collision` | error | Two paths differ only in case (`audit`). |
| `project/missing-include` | error | An `INCLUDE` names a library that is not beside the file (`audit`). |
| `project/path-escape` | error | A `.alcor` path resolves outside the audited root (`audit`). |
| `project/root-missing` | error | The audit root does not exist (`audit`). |

## Verification

```bash
python -m pytest tests/test_alcorlint.py -q
python -m alcorlang selftest
```

The suite covers normalized parse failures, warning semantics, effect and flow rules,
include and path checks, deterministic JSON, strict exit behaviour, `.alcor`-only path
selection and symlink/escape refusals. Two tests skip on some machines: the case-collision
test on a case-insensitive filesystem, and the symlink test where symlinks are unavailable.
