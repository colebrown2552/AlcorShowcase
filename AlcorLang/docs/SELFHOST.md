# SELFHOST.md — AlcorLang interpreting AlcorLang

`selfhost/alcorlang.alcor` is an AlcorLang v2 interpreter **written in AlcorLang v2**. It reads an
AlcorLang program off the input tape and writes the output tape the reference interpreter
(`alcorlang.run`) would write for that program.

- **1,865 lines · 50,994 bytes · 64 `PROGRAM` blocks** — 37 interpreter blocks plus the 27
  `Str*`/`Ns*`/`Pair*` blocks copied **verbatim** from `selfhost/alcorstr.alcor`.
- Entry block: `PROGRAM AlcorLangHost WITH profile=complete authority=conformance fuel=0`. Unbounded
  host fuel is the honest §5 setting for an interpreter; the guest is bounded by the interpreter's
  **own** statement budget, which reports itself by a distinguishable name.
- v2 has **no comment syntax** (`#` is `unknown verb token '#': not in the periodic table`), so the
  prose lives here, and a machine-readable summary lives inside the program itself — see
  `%%COVERAGE%%` below. (The v3 syntax adds `#` and `//` comments, but that is a frontend feature;
  the host interprets v2.)

**Status in one paragraph.** The interpreter is real and tested differentially against the
reference, including running the string library's own self-test and running itself. It is *not* a
bootstrap: it is started by the Python reference interpreter, it costs roughly 1,600 to 6,500 times
as many interpreter steps on the programs measured below, and it deliberately refuses the parts of
the language that need a door out of the sandbox (effects, `INCLUDE`, `fuel=N`, code generation).
Those refusals are loud, not silent.

## Run it

From the component folder:

```bash
# run a guest program on the self-hosted interpreter and compare with the reference
python -m alcorlang host programs/quorum_gate.alcor

# the raw form: the host program, with the tape on --input
python -m alcorlang run selfhost/alcorlang.alcor --input TAPE

# ask the interpreter what it covers, with no program at all
echo '%%COVERAGE%%' | python -m alcorlang run selfhost/alcorlang.alcor --input -

# the differential sweep over every operator (1650 programs, about a minute)
python -m alcorlang host --sweep
```

(Write the sentinel literally: `printf` treats `%%` as an escape for one `%`, and the interpreter
would then — correctly — read the line as the first line of a program rather than the sentinel.)

## The tape

One tape carries both the guest program and the guest's own input. Two framings:

**Sentinel (hand-written).** Source lines, a line that is exactly `%%END%%`, then the guest's
input lines:

```
PROGRAM Main
READ $who
EMIT CAT "hello, " $who
END PROGRAM
%%END%%
world
```

**Count (generated).** First line `%%ALCOR%% <source-line-count> [<statement-budget>]`, then exactly
that many source lines, then the guest's input. Unambiguous — a guest whose own text contains a
`%%END%%` line is only safe in this mode. `alcorlang.selfhost.make_tape` produces it.

```
%%ALCOR%% 4 100000
PROGRAM Main
READ $who
EMIT CAT "hello, " $who
END PROGRAM
world
```

The optional second field overrides the guest statement budget (default **100,000**).

---

## What is hosted

Byte-identical to `run()` on every construct below.

| | |
|---|---|
| **Statements** | `LET` · `EMIT` · `READ` · `LABEL` · `JUMP` · `BRANCH … [ELSE …]` · `LOOP WHILE … / END LOOP` · `CALL Name [WITH $c=expr …] [INTO $c]` · `RETURN [expr]` · `PROGRAM [Name] [WITH …] / END PROGRAM` · `;` and newline as separators |
| **Operators** | all 21: `ADD SUB MUL DIV MOD NEG CAT LEN STR INT CHAR FIND EQ NE LT LE GT GE AND OR NOT` |
| **Values** | `int` (unbounded — `ADD 100000000000000000000 1` is exact), `str` (UTF-8, code-point indexed), `bool` |
| **§6.2 corners** | floor `DIV` / divisor-signed `MOD` (`DIV -7 2` = `-4`, `MOD -7 2` = `1`); cross-type `EQ`/`NE` yields `false`/`true` and never traps; cross-type `LT LE GT GE` traps, **including bool-bool**; `CHAR`/`FIND` total; `INT` accepts exactly `-?[0-9]+`; `AND`/`OR` evaluate both arguments |
| **Traps** | `div_zero mod_zero type_mismatch undefined_cell bad_int input_exhausted`, with the tape-so-far preserved ahead of the `TRAP` line |
| **Frames** | one environment per frame, args **by value**, `RETURN` delivers into the caller's `INTO` cell, `RETURN` with no expression and falling off the end both return `int 0`, **recursion** (checked to depth 300) |
| **§5 static checks** | profile + authority, `REFUSED unsigned_complete`, backward-`JUMP`/`BRANCH` rejection under `default`, `LOOP` rejection under `default`, **call-cycle rejection under `default`**, unknown label, duplicate label, duplicate `PROGRAM` name, unnamed non-entry block, `PROGRAM` property validity, statement shape, expression arity, trailing-token detection |

The static checks run **before any output**, as the reference's do. That matters: a hosted
interpreter that checks lazily emits the guest's first lines and *then* discovers the program was
never legal.

### The safety invariant survives self-hosting

§8.3 is not sacrificed. The same loop, under three headers:

```
PROGRAM Main                    → COMPILE-ERROR backward jump to label 'top' is rejected
                                  by the default profile (default programs are finite DAGs)
PROGRAM Main WITH profile=complete
                                → REFUSED unsigned_complete
PROGRAM Main WITH profile=complete authority=conformance
                                → 0 / 1 / 2
```

The reference gives the same three verdicts (re-run for this document). **The halting invariant
(§8.3) is hostable and hosted; the gate invariant (§8.1) is not — see below. That asymmetry is the
honest headline.**

---

## What is NOT hosted

Every one of these is refused **out loud** on the first line of the tape. None is silently mis-run.

### v1 EFFECT statements — structurally unhostable

```
UNSUPPORTED v1-effect-statement 'WRITE': §6.4 defines an embedded v1 statement as an
EFFECT whose semantics are the host gate adapter's answer. A hosted interpreter can only
inline it (breaks §8.1) or drop it (breaks §8.2), so it refuses instead.
```

§6.4 defines an effect's meaning as *the host gate adapter's answer*; §8.1 forbids inlining one;
§8.2 requires every attempt to be individually classified and receipted. No AlcorLang expression
reaches the gate adapter, so a hosted interpreter has exactly two options — inline (violates §8.1)
or drop (violates §8.2). It takes neither. **The safety architecture is precisely what makes the
effect layer unhostable, and the right behaviour is a loud refusal, never a faked receipt.**

A second, sharper consequence: the hosted interpreter **cannot tell a valid effect from an unknown
verb**. `WRITE File "x"` (which the reference gates and receipts) and `FROB Task` (which the
reference rejects as `unknown verb token`) are the same shape to it, because the vocabulary table
is a host artifact and AlcorLang has no door to it. Both are refused with the same message. This
applies to bare v1 modules (§1.1 dispatch) as well as embedded ones.

### `INCLUDE` — no filesystem door

```
UNSUPPORTED INCLUDE: §12 resolves a library from the filesystem before the lexer runs,
and AlcorLang has no filesystem door. Inline the library instead.
```

This is also why `alcorlang.alcor` carries a **copy** of the string library rather than an
`INCLUDE` of it. Two independent reasons:

1. The reference runs the host with no include root: `run(src, text)` is called with no
   `base_dir`, and says `INCLUDE "alcorstr.alcor": the host granted no include root.`
2. §12 judges a library **alone at the default profile**, so a library may not loop or recurse.
   Every general string routine needs unbounded iteration. **No useful string library can ever be
   an `INCLUDE` library** — that is §12 working, not a bug to route around.

### `fuel=N` for N > 0

```
UNSUPPORTED fuel=500: the host counts guest statements, not ALCORCORE instructions, so it
cannot reproduce the guest's own fuel wall. fuel=0 (unbounded) is accepted.
```

Honouring `fuel=N` approximately would mean trapping at the wrong instruction. `fuel=0` is
accepted because it asks for no accounting at all.

### `lower_python` / `lower_c` — writable, deliberately not written

They are pure string transforms and well within reach. But nothing in the AlcorLang world can
*execute* Python or C, so their correctness could not be checked in-language — they would be
unfalsifiable code. Excluded on that ground, and the ground is worth stating.

---

## What is partial

**Compile-error text.** The reference *raises* (the CLI prints to stderr and exits 1, stdout
empty); a hosted interpreter can only write to the tape. Hosted rejections appear as one
`COMPILE-ERROR <reason>` line. What is guaranteed is the **verdict**, not the wording: every input
the reference rejects, the hosted interpreter also refuses, and vice versa. That equivalence is
what the harness tests. `REFUSED unsigned_complete` is the one refusal that *is* byte-identical,
because §6.3 specifies it as tape output.

Where several errors exist at once, the two may report *different* ones: the reference interleaves
per-block duplicate-label collection with that block's jump checks, while the hosted pass collects
all labels first.

**Guest fuel.** The reference gives a guest 10,000,000 ALCORCORE steps. The hosted interpreter
counts **guest statements** and stops a runaway with

```
HOST-STEP-LIMIT 2000 guest statements: the hosted interpreter stopped here, the guest
program did not finish
```

which is deliberately **not** the string `TRAP fuel_exhausted`. A truncated run therefore never
impersonates a guest that legitimately ran out of fuel.

---

## Fidelity evidence

Everything below was run for this document, with `alcorlang.selfhost` (`compare()` runs the
reference and the host on the same guest and classifies the pair). A reject case passes only when
the reference rejects **and** the hosted interpreter refuses with a `COMPILE-ERROR` /
`UNSUPPORTED` / `REFUSED` first line. Any input the reference rejects and the hosted interpreter
*runs* would be a P0 — the language silently widened. That is the definition of "hosted" used
here: **a construct is hosted only when it is accepted and rejected identically.**

| check | cases | result |
|---|---|---|
| operator sweep (`python -m alcorlang host --sweep`) | 1,650 | 16 binary operators × 10 typed operands² + 5 unary × 10: **1,650 identical, 0 mismatches** |
| conformance corpus, `parse`/`run`/`gate` tests | 27 | 19 identical, 3 both reject (the fail-closed parse tests), 5 refused by design (the tests that contain a v1 effect) |
| program corpus, run-mode cases (`programs/corpus.json`) | 13 | 12 identical, 1 refused by design (`translate_request.alcor`, which has directives and so effects) |
| the three profile verdicts above | 3 | as documented |
| guest blocks named like the interpreter's own library (`StrSlice`, `NsPut`) | 1 | dispatched to the **guest's** definitions, output identical |
| recursion to depth 300 | 1 | identical (3,267,733 host steps) |

The ten operands are `0 1 -7 2 "" "a" "abc" "-12"` and the two booleans `EQ 1 1` and `EQ 1 0`;
ill-typed combinations are included on purpose, because the traps are the semantics.

The adversarial cases are the ones worth naming, because they are where a string-encoded
interpreter is supposed to break: guest blocks that share names with the interpreter's own library
blocks, and (covered by the design, not re-run in this sweep) label and program names that are
prefixes of one another, and cell values that look like netstrings or like an environment key
record.

### Real programs, not just test cases

| guest | size | result |
|---|---|---|
| the policy programs in `programs/` (with inputs) | 676 B to 1.7 KB | identical to the reference |
| `selfhost/alcorstr.alcor` (its own 135-assertion self-test) | 786 lines, 31 blocks | **169 lines, byte-identical, ending `ALCORSTR PASS`**; 48,599 reference steps against 156,719,441 host steps (3,225×); 91 to 120 s |
| `selfhost/alcorlang.alcor` running **itself** running a program | 1,865 lines | `two levels deep: 5`, 73,861,171 host steps, 45 to 67 s |

The last row is the real claim: **AlcorLang interpreting AlcorLang interpreting AlcorLang.** The
tape is just the interpreter, `%%END%%`, the inner program, `%%END%%` — sentinel framing nests
without any special support, because the inner interpreter's `READ` continues off the same tape.

---

## What it costs

All figures are step counts from `run_metered` (one ALCORCORE instruction = one step), so they
are deterministic. Wall-clock time depends on the machine; here CPython 3.12 does roughly 1.1 to
1.3 million steps per second.

**Front end** — lex → split → shape-check → scan → jump-check → cycle-check — is
**≈ 462 host steps per source byte, linear**: marginal cost 462.5 steps/byte at 0.5 KB, 462.4 at
3.6 KB (measured with statements that are checked but never executed).

**Execution** — one iteration of a three-statement loop body (`LOOP WHILE LT $i n`, two `LET`s)
costs **≈ 8,500 host steps** (8,489 and 8,548 for the 50→100 and 100→200 iteration steps).

| program | reference core steps | hosted host steps | slowdown |
|---|---|---|---|
| 3 lines, one `EMIT` | 3 | 16,800 | — (front-end floor) |
| sum 1..10 (9 lines) | 99 | 161,496 | 1,631× |
| `quorum_gate.alcor` (676 B) | 62 | 390,521 | 6,299× |
| `capped_backoff.alcor` (1.4 KB) | 139 | 786,970 | 5,662× |
| `alcorstr.alcor` self-test | 48,599 | 156,719,441 | 3,225× |

The interpreter declares `fuel=0`, so the reference's `DEFAULT_FUEL` does not apply to it; the
binding limit is its own 100,000-statement guest budget (the runaway example above stops at its
budget of 2,000 after 1,280,346 host steps).

### The cost that is still a linear scan, documented rather than hidden

**Cell lookup is O(#cells in the frame).** The same 50 iterations cost 493,964 host steps with two
cells, 1,009,711 with twelve and 1,611,241 with twenty-two. The environment is a flat key/value
netstring blob scanned with a length pre-filter. The environment deliberately does **not** use the
`FIND`-the-exact-record trick that label, block and loop lookups use: a guest string value *can*
contain `4:=abc,`, so `FIND` on the environment would be forgeable by the guest. Labels, blocks and
loops are safe to look up that way only because their payloads (label keys `<block>/<name>`,
decimal offsets, program names, `#<n>`, `L<pc>`/`E<pc>`) can contain neither `:` nor `,`.

---

## Known limits

**Exotic line separators break the tape transport.** The host's own `READ` is
`input_text.splitlines()`, which splits on `\v`, `\f`, `\x85`, ` ` and ` ` as well as
`\n`. A guest source containing one of those is not faithfully transportable. Usually the damage
is loud:

```
guest: EMIT "a\vb"   ref='a\x0bb\n'   hosted='COMPILE-ERROR line 2: newline inside string literal\n'
```

but it can be silent, and this is the **one place** where the hosted interpreter runs a program the
reference rejects:

```
guest: EMIT 1\vEMIT 2   ref=rejected ('1\x0bEMIT' is not an operator, …)   hosted='1\n2\n'
```

This is a property of the transport, not of the interpreter: the characters are gone before any
hosted code sees them. `\r\n` sources are fine (`\r` is lexer whitespace either way), and so is
arbitrary UTF-8 inside string literals — `LEN "café 中"` = 6 and `CHAR "café 中" 3` = `é` in both.
(Both examples above were re-run for this document; `compare()` reports them as `mismatch`, which
is the correct verdict.)

**A missing `%%END%%` reads as `TRAP input_exhausted`.** Sentinel mode cannot distinguish an
unterminated tape from a guest that over-reads its input. Count mode cannot have this problem;
prefer it for anything generated.

**A guest source containing a bare `%%END%%` line is cut there in sentinel mode.** In practice this
appears as `COMPILE-ERROR unterminated block: expected END PROGRAM`, because the cut lands
mid-block — but a cut that lands exactly on a block boundary would truncate silently. Count mode
is immune.

**Non-ASCII cell names are rejected by a different route.** The reference scans a cell name with
Python's Unicode-wide `isalnum()` and then rejects it against `[a-z][a-z0-9_]{0,31}`; the hosted
lexer's character class is ASCII, so it stops earlier. Both reject `$éx`; the messages differ.

**Character predicates take exactly one character** as produced by `CHAR` — inherited from
`alcorstr.alcor`, unenforced, documented there too.

---

## Maintaining it

`alcorlang.alcor` contains a byte-identical copy of `alcorstr.alcor`'s library region (every block
named `Str*`, `Ns*` or `Pair*`). Sync is checkable, and this check is required before changing
either file:

```bash
python -c "from alcorlang import selfhost; print(selfhost.library_in_sync())"
```

`library_in_sync()` extracts each file's `PROGRAM (Str|Ns|Pair)… END PROGRAM` blocks and compares
them; it is false if either side is empty, so the check cannot pass vacuously.

Regenerate `alcorlang.alcor` by concatenating the interpreter blocks with that extracted region;
the interpreter blocks are all named `Host*` precisely so the two regions cannot collide.

Any change to either file should be re-run against the differential harness. It is the only thing
standing between "it works on my examples" and "it is an implementation":

```bash
python -m alcorlang host --sweep                  # every operator, 1650 programs
python -m alcorlang host programs/quorum_gate.alcor
```

or, from Python, `selfhost.compare(guest_src, guest_input)` returns a `Verdict` whose `kind` is
`identical`, `both-reject`, `refused-by-design` or `mismatch`. The harness runs the host through
`run_metered` with a fuel ceiling, which is what keeps a harness run bounded even though the
interpreter itself declares `fuel=0`; never run the host through plain `run()` in a harness.
