# AlcorLedger: a hash-chained, append-only ledger with a privacy gate

AlcorLedger is a tamper-evident log for an AI agent's memory and decisions. Every entry is linked to
the one before it, so a later edit is detected, and secrets such as passwords, tokens or email
addresses are refused before they can be written.

![AlcorLedger viewer](screenshots/viewer.png)

Long-lived agent memory and decision logs get copied, committed and published, and a secret that
lands in one is hard to take back. The ledger stores each entry as one JSON line that carries the
SHA-256 of the line before it, and it scans every entry for private data before anything is
written: by default it refuses, and on request it replaces the value with a marker. `verify`
re-checks the chain, the schema and the privacy policy for the whole file, and an append refuses to
extend a file that fails. The Python package is `continuity-core` (import `continuity_core`,
command `continuity`).

## See it

Open `viewer/index.html` in a browser to explore a recorded demo run.

## Highlights

- **Refuse first, redact on request.** An entry is rejected if it contains an email address; a
  bearer, GitHub or `sk-` style token; a private-key header; a URL with embedded credentials; a
  home-directory path; an IPv4 or MAC address; or any value under a key such as `password`.
  Redaction is an explicit flag because silently rewriting a statement could hide a bad upstream
  data flow. Redacted entries are scanned again, and refused if anything detectable is left.
- **Findings never contain the value.** A finding carries the category, the location, the length
  and a 12-character fingerprint of the match. Error messages and logs stay safe to keep, and two
  findings can still be told apart.
- **Verify before every append.** `append` takes the write lock, verifies the whole file, links to
  the last hash, writes one line and calls `fsync`. A damaged ledger is never extended. The price is
  that each append re-reads the file, so cost grows with ledger size.
- **Canonical bytes.** Entries are stored as JSON with sorted keys and no extra whitespace, and the
  hash is taken over exactly that form. The hash depends only on the data, so the demo prints the
  same hashes on every run.
- **One error per edit.** The next line is linked to the hash the previous line *claims*, not the one
  it should have. An edited line is reported once, on its own line, and a forger who recomputes that
  line's hash is caught on the following line instead.
- **Standard library only.** Writers are serialized by an in-process lock plus a lock file created
  with `O_EXCL`. There are no runtime dependencies.

## How it works

```mermaid
flowchart TD
    A["append(entry)"] --> B["check schema, fill defaults"]
    B --> C{"private data found?"}
    C -- "no" --> E["take the write lock"]
    C -- "yes, redact=False" --> X1["SensitiveDataError: nothing is written"]
    C -- "yes, redact=True" --> D["replace values with markers, scan again"]
    D --> E
    E --> F{"does the whole file verify?"}
    F -- "no" --> X2["ChainError: nothing is written"]
    F -- "yes" --> G["link to the last entry_hash and hash the entry"]
    G --> H["write one line, fsync, release the lock"]
```

Each line has `id`, `kind` (`memory`, `observation`, `decision` or `wishlist`), a kind-specific
`status`, `statement`, `confidence`, `provenance`, `tags`, `supersedes`, `metadata`, `created_at`,
`expires_at`, and the three fields the ledger adds: `schema_version`, `previous_hash` and
`entry_hash`. `entry_hash` is the SHA-256 of the line's canonical JSON without `entry_hash` itself;
`previous_hash` is inside that JSON, so every entry commits to the whole chain before it. The first
entry points at 64 zeros.

`verify` checks every line for the exact field set, the link to the previous line, its own hash, a
unique id, the privacy policy and the schema, and keeps going so one run lists all the damage.
`reconstruct.py` is a worked example of using the chain as the source of truth: three tagged
entries record a three-turn exchange as hashes, and it rebuilds a state digest from the ledger
alone and checks the invariants (ordered turns, one thread, one terminal result per turn, no cache
use, turn 3 in a different process than turns 1 and 2).

## Run it

From the repository root, with no install:

```bash
python AlcorLedger/demo/run_demo.py      # chain, privacy gate, tampering, CLI, reconstruction
python AlcorLedger/continuity.py verify AlcorLedger/examples/principles.jsonl
```

The demo needs no network and prints one `proven:` line per claim, ending with
`All 22 claims proven.`; it exits non-zero if any claim fails.

![AlcorLedger demo output](screenshots/demo.svg)

With the `continuity` command installed:

```bash
pip install -e AlcorLedger
continuity init AlcorLedger/demo/state               # git-ignored scratch folder
continuity append AlcorLedger/demo/state/memory/public.jsonl --kind decision --statement "Receipts outrank narrative confidence."
continuity append AlcorLedger/demo/state/memory/public.jsonl --kind memory --statement "Mail alice@example.com"            # exit 2, refused
continuity append AlcorLedger/demo/state/memory/public.jsonl --kind memory --statement "Mail alice@example.com" --redact   # stored with a marker
continuity verify AlcorLedger/demo/state/memory/public.jsonl
```

`continuity scan <paths>` looks for private data in files and exits 1 if it finds any. Exit codes
are 0 for success, 1 for a failed check and 2 for an error such as a refused entry.

## Tests

```bash
python -m pytest AlcorLedger                                          # 29 tests
PYTHONPATH=AlcorLedger/src python -m unittest discover -s AlcorLedger/tests   # without pytest (bash)
```

Start with `test_ledger_hardening.py` (damaged ledgers are never extended) and
`test_continuity_three_turn.py`.

## Read the code

| File | Look at first |
|---|---|
| `src/continuity_core/ledger.py` | `JsonlLedger.append` (lock, verify, link, fsync) and `JsonlLedger.verify` (the per-line checks); `_canonical_json` and `_entry_hash` define what is hashed |
| `src/continuity_core/redaction.py` | `_PATTERN_SPECS` (the detectors), `redact_text` (merges overlapping matches), `_blocked_key` (sensitive key names) |
| `src/continuity_core/cli.py` | `main` and the exit codes; the `init`, `append`, `list`, `verify` and `scan` verbs |
| `src/continuity_core/reconstruct.py` | `reconstruct`: the invariant checks, in order |
| `continuity.py` | The no-install launcher (puts `src` on the import path) |
| `examples/principles.jsonl` | A six-entry ledger that verifies |
| `demo/run_demo.py` | The walk-through, including the tamper and forger cases |

## Limitations

- **Tamper-evident, not tamper-proof.** Editing, reordering or deleting a middle line is detected.
  Deleting the newest entries, or rewriting every line from an edit onward with fresh hashes, still
  verifies, because the chain has no secret key. Keep the newest `entry_hash` somewhere else to catch
  that; demo part 7 shows it. A valid chain proves the file is internally consistent, not that its
  statements are true or who wrote them.
- **The detectors are regular expressions.** They cover the shapes listed above and a fixed list of
  sensitive key names. They miss secrets in other forms, and they flag some harmless text; for
  example, a four-part version number looks like an IPv4 address. They are a last line of defense,
  not a replacement for secret scanning at the hosting provider.
- **The lock is advisory.** If two waiters break the same stale lock (older than 120 s) at the same
  instant, both can write; `verify` reports the resulting broken chain and later appends refuse to
  extend it.
- **Local and single-file.** No encryption, signing or network. Tested on Windows with Python 3.12;
  the code targets Python 3.10+.
- **`reconstruct` checks recorded claims.** It shows the evidence is complete and consistent; it does
  not observe the processes the entries describe.
