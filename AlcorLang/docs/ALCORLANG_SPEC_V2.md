# ALCORLANG v2 — "The Complete Core"
**Spec version:** 2.0.0
**Judge:** `alcorlang/referee.py` + `conformance/conformance_v2.json` (the corpus is the ground truth; where prose and corpus disagree, the corpus wins and the disagreement is a spec bug — report it, don't guess).

> **Scope.** This is the specification the code in this folder implements. The v1 task language is described only as far as v2 needs it; its compiler is not implemented. The vocabulary table (`alcorlang/data/periodic_table.json`) holds 23 elements, and any token that is not in it fails closed, as the spec says.

---

## §0 Purpose & lineage

AlcorLang v1 is a **deliberately sub-Turing** task language: one statement per program, fail-closed vocabulary (a fixed table of named elements), effects behind a gate, hash-chained receipts. Every v1 program provably halts. That is a safety feature, not a gap.

v2 answers: *how complete can this language get, and can it lower to Python, C, and assembly?* Answer: fully Turing-complete (complete profile, §9), lowering ladder in §7 — **without** giving up v1's invariants. Loops require authority; the default profile still halts; effects still route through the gate in every backend.

## §1 Grammar

### §1.1 Dispatch rule (backward compatibility)
A source whose **first token is not `PROGRAM`** is a **v1 program**: exactly one statement, v1 grammar, v1 semantics, unchanged. `PROGRAM` is fail-closed-rejected by v1 today, so no existing program changes meaning.

### §1.2 v1 statement grammar (unchanged, restated)
```
v1_stmt   := VERB OBJECT [ quoted_value ] [ WITH prop=val ... ] [ (TO|FROM) OBJECT [ name_or_path ] ]
```
`VERB` and `OBJECT` must canonicalize into the vocabulary table (fail-closed otherwise). Aliases used by this spec's corpus: `WRITE → Update`, `SET → Update` (the compat trap: `SET` is **not** a cell operation, see §3), `OPEN → View`, `SEND → Message`, `SEARCH → Search`. `name_or_path` after a TO/FROM object keeps v1's greedy-join semantics.

### §1.3 v2 blocks
```
module    := { v1_stmt | program }+
program   := "PROGRAM" [ Name ] [ "WITH" prop=val ... ] NL stmt_list "END" "PROGRAM"
stmt_list := { stmt (NL | ";") }
stmt      := v1_stmt                      # embedded effect (§6.4)
           | "LET" cell expr
           | "EMIT" expr
           | "READ" cell                  # one line from input_text
           | "LABEL" name
           | "JUMP" name
           | "BRANCH" expr name [ "ELSE" name ]
           | "LOOP" "WHILE" expr NL stmt_list "END" "LOOP"
           | "CALL" Name [ "WITH" cell "=" expr ... ] [ "INTO" cell ]
           | "RETURN" [ expr ]
cell      := "$" [a-z][a-z0-9_]{0,31}
name      := [a-z][a-z0-9_]{0,31}         # labels: program-local, unique
Name      := [A-Za-z][A-Za-z0-9_]{0,31}   # program names
```
**Reserved words** (v2-only; all are fail-closed rejects in v1 today): `PROGRAM END LABEL JUMP BRANCH LOOP WHILE CALL LET INTO ELSE RETURN EMIT READ`. Deliberately **not** claimed (v1 alias collisions): `SET RUN EXEC START IF THEN HOOK`.

Keywords are special **only at statement head** (and `WITH/INTO/ELSE/WHILE` in their marked positions). Statements separate by newline or `;`. A module may contain several `PROGRAM` blocks; **execution entry is the first block**; later blocks are CALL targets.

### §1.4 Expressions (prefix / Polish notation)
```
expr := int_literal | quoted_string | cell | OP expr...    # fixed arities: 1 or 2
OP   := ADD SUB MUL DIV MOD NEG            # arithmetic (NEG unary)
      | CAT LEN STR INT                    # strings   (LEN/STR/INT unary)
      | CHAR FIND                          # looking inside a string (both binary, both total)
      | EQ NE LT LE GT GE                  # comparison
      | AND OR NOT                         # boolean   (NOT unary)
```
Prefix notation ⇒ no precedence, no ambiguity. Expressions appear **only** after `LET`, `EMIT`, `BRANCH`, `WHILE`, `RETURN`, and CALL arg values (`READ` takes a cell, not an expression). Operators are a closed set, distinct from the vocabulary table, which is untouched.

## §2 Vocabulary & keyword policy
The vocabulary table (the "periodic table", `alcorlang/data/periodic_table.json`) remains the **only** source of v1 VERB/OBJECT tokens; v2 adds **zero** elements. All v2 constructs live in the parser/interpreter. Registry keys stay `(verb, object, target|None)`.

Each element carries a `role` of `verb`, `object`, or both, which turns on the verb/object position check: a token in the wrong position is rejected. A table with no role data skips that check, and `table()` and the linter's `vocabulary/role-check-skipped` rule say so rather than guessing. Roles are part of `semantic_vocabulary_snapshot()`, so changing a role changes every hosted run's `vocabulary_sha256`.

## §3 Cells & interpolation
- `LET $x <expr>` assigns. Cells are program-frame-local (§6.3). Reading an unassigned cell **traps** (`undefined_cell`).
- **Interpolation (GET):** `$x` may appear inside the quoted value or WITH-prop values of an *embedded v1 statement*. Substitution is **inert data**: never re-tokenized, never eval'd, and **gate descriptors keep the raw placeholder text** (§8.4). `EMIT $x` emits the value.
- **The compat trap, explicitly:** `SET Task "x"` is a v1 statement (Update/Task), *not* a cell op. Cells exist only via `LET` + `$sigil`. The corpus asserts this (`m1-v1-set-is-update`).

## §4 Control flow
- `LABEL name` / `JUMP name` — program-local, names unique, unknown label = compile error.
- `BRANCH <expr> then_lbl [ELSE else_lbl]` — condition must be **pure** (expressions cannot contain effects — they can't, structurally). Truthiness: bool itself; int ≠ 0; str ≠ "".
- `LOOP WHILE <expr> … END LOOP` — sugar for LABEL/BRANCH/JUMP.
- `CALL Name WITH $a=<expr> … INTO $ret` — args **by value** into the callee's fresh frame; one return value via `RETURN <expr>` (RETURN with no expr returns int 0; falling off the end returns int 0).

## §5 Profiles & authority
Declared on the entry block: `PROGRAM [Name] WITH profile=default|complete [authority=…] [fuel=N]`. Absent ⇒ `profile=default`.

- **default** — the halting profile (what autonomy runs): `LOOP`, backward `JUMP` (a jump to a label defined at an earlier statement index), and recursion (any cycle in the static call graph) are **rejected at compile time**. Programs are finite DAGs ⇒ provably halting.
- **complete** — unbounded control flow. Requires authority:
  - **Hosted execution:** authority verified by the host for the exact run (§6.4, `run_hosted`): an opaque capsule bound to a challenge that names the source, compiled Core, vocabulary, runtime build, input and effect scope. Out of referee scope.
  - **Sandbox/conformance:** `authority=conformance` is granted **only** inside a sandbox and this corpus. Hosts MUST reject it. This keeps M1–M2 implementable without cryptography; the verified path is the only real-world door.
  - A `complete` program **without** valid authority parses fine but is *prepared-not-run*: `run()` returns exactly `REFUSED unsigned_complete\n` and performs nothing.
- **fuel** — `complete` only. Default cap `10000000` steps; `fuel=N` overrides; `fuel=0` = unbounded (the honest Turing-complete setting). Fuel exhaustion ⇒ trap `fuel_exhausted`.

## §6 ALCORCORE IR & operational semantics
The source language compiles to ALCORCORE — the two-implementations-must-agree layer.

### §6.1 Instructions (11)
```
CONST dst lit · MOV dst src · BINOP op dst a b · UNOP op dst a
JMP pc · JZ src pc · CALL prog args dst · RET src?
IO op dst arg          # op ∈ {read_line, emit}
EFFECT shape args dst  # the ONLY effectful instruction
HALT
```
Flat list, pc-indexed, per-frame registers (cells lower to named slots), an output tape of strings, an input cursor over `input_text` lines.

### §6.2 Values & operators (total semantics — no undefined behavior)
Values: `int` (unbounded in the reference), `str` (UTF-8; ordering byte-wise), `bool`.
- `ADD SUB MUL DIV MOD NEG`: ints only, else trap `type_mismatch`. `DIV`/`MOD` by zero ⇒ trap `div_zero` / `mod_zero`. DIV is floor division; MOD result has the divisor's sign (Python semantics — stated so C must match).
- `CAT`: str×str ⇒ concat, else trap. `LEN`: str ⇒ int, counted in **Unicode scalar values (code points)** — see below. `STR`: any ⇒ its EMIT rendering. `INT`: str of optional `-` + digits ⇒ int, else trap `bad_int`; int ⇒ itself; bool ⇒ 0/1.
- `CHAR s i`: the one-character string at code-point index `i`, or `""` when `i` is off either end of `s`; `type_mismatch` unless `s` is a str and `i` an int (not a bool). `FIND s needle`: the code-point index of the first occurrence of `needle` in `s`, or `-1`; `type_mismatch` unless both are strings. Both are **total on purpose**: a lexer's inner loop asks "am I past the end?" on every step, and a trap there would mean the only way to ask is to have already fallen off. `""` is falsy, so `BRANCH EQ $c "" done` is the end test. These two are the smallest addition that lets a program look inside a string, which is what lets a lexer, and so an interpreter, be written in AlcorLang (see `docs/SELFHOST.md`).
- `LEN`'s unit is stated because it was not: the reference counted code points while the C runtime counted bytes, so `LEN "café"` was 4 in Python and 5 in C and an all-ASCII corpus could not see the split. Every backend counts **Unicode scalar values** — `é` is one, and an astral scalar such as U+1F600 is one, not the two UTF-16 units or four UTF-8 bytes it occupies. That count is also the index space `CHAR`/`FIND` work in, so `i < LEN s` stays a safe bound for `CHAR s i`.
- `EQ`/`NE` across different types ⇒ `false`/`true` (no trap). `LT LE GT GE` across different types ⇒ trap `type_mismatch`; int-int numeric; str-str byte-wise.
- `AND OR NOT`: operate on truthiness (§4), return bool. AND/OR evaluate both args (no short-circuit — prefix notation, deterministic cost).

### §6.3 Execution
Frames hold cells; CALL copies evaluated args into a fresh frame; RET delivers the value into the caller's `INTO` cell (or discards). `READ $x`: next input line (without `\n`) into `$x`; past-EOF ⇒ trap `input_exhausted`. `EMIT e`: append rendering — int → decimal, str → as-is, bool → `true`/`false`.

**run(src, input_text) → str:** the output tape joined by `\n` with a trailing `\n` iff the tape is non-empty.
**Trap:** execution stops; output = tape-so-far + `TRAP <code>\n`. Trap codes: `div_zero mod_zero type_mismatch undefined_cell bad_int input_exhausted fuel_exhausted`.
**Refusal (§5):** output exactly `REFUSED unsigned_complete\n`.

### §6.4 EFFECT (the gate, in every backend)
Every **embedded v1 statement** inside a program lowers to `EFFECT`. Semantics are *defined as the host gate adapter's answer* — never inlined:
- **M2 (pure executor):** the stub `not_wired` produces no tape output and no effect. Each attempt writes one self-hashed `alcor.effect.result.v1` refusal to `receipts/effect_<seq>.json`; the corresponding request keeps raw and resolved fields separate.
- **Hosted interpreter:** the immutable host context verifies exact run authority, persists `ATTEMPTED`, calls the byte gate once, validates `alcor.effect.result.v1`, then persists the terminal receipt. Existing `ATTEMPTED` is `UNKNOWN`, never replayed. The durable store is the host's: this repository ships the `EffectLifecycle` interface and an in-memory reference implementation, `InMemoryLifecycle`.
- **M3+ (standalone lowered Python):** no ambient module discovery and no authority. It writes the same deterministic typed `not_wired` refusal as the pure executor.
- **M4 (C):** the versioned `alcor_gate_effect_v1` byte ABI is reserved, but effectful native execution remains refused until resolved request construction, a reviewed host shim, and executable parity exist.

## §7 Lowering ladder (honest claims per level)
| Level | Artifact | Fidelity | Completeness claim |
|---|---|---|---|
| Reference | Core interpreter in Python (`run`) | full: unbounded ints, total trap semantics | **Turing-complete** (complete profile, fuel=0) |
| `lower_python` | Core → Python source | must reproduce `run` byte-identically on the corpus | Turing-complete |
| `lower_c` | Core → C (typed static subset) | int64 + overflow-trap; CALL targets static; immutable length-prefixed strings (CAT allocates); IO = stdin-lines/stdout-tape; EFFECT reserves the v1 byte ABI but traps closed | same language on a bounded machine — TC up to resources, like any real compiler |
| asm | `cc -S` on the C output | — | inherits C level (`python -m alcorlang native asm`). A small bytecode VM with a 1:1 Core→bytecode assembler was an idea for a more direct, inspectable "assembly"; it is not implemented here |

## §8 Safety invariants (non-negotiable, all backends)
1. Effects route through the one typed gate boundary; no backend inlines an effect. Standalone Python and current C have no effect authority.
2. Every effect attempt is individually classified + receipted; loop iterations are separate attempts.
3. `default` halts by construction; `complete` requires authority (§5); `authority=conformance` is sandbox-only.
4. **No eval, ever.** `$cell` interpolation is inert data; gate descriptors carry raw placeholder text, not interpolated content.
5. The vocabulary table is untouched by v2: v2 lives in the parser/interpreter only.

## §9 Turing-completeness proof (Minsky embedding)
A 2-counter Minsky machine is Turing-complete. Embedding: counters = cells `$c1 $c2` (unbounded naturals); machine state `qᵢ` = `LABEL qi`; `INC(c, j)` = `LET $c ADD $c 1` + `JUMP qj`; `DECJZ(c, z, j)` = `BRANCH EQ $c 0 qz` then `LET $c SUB $c 1` + `JUMP qj`. Backward JUMP is unbounded under `complete` with `fuel=0` and ints are unbounded ⇒ any Minsky machine (hence any Turing machine) is expressible. Worked doubling program: conformance test `m2-minsky-double`.

## §10 Conformance & milestones
The corpus (`conformance/conformance_v2.json`, referee schema `{"version":2,"tests":[…]}`) is judged by `alcorlang/referee.py` (`python -m alcorlang conformance`). An implementation is any importable `alcorlang` (a package or one `alcorlang.py`) exposing:
```
parse(src) -> ast_dict            # M1+
run(src, input_text='') -> str    # M2+   (RETURNS the output, never prints)
lower_python(src) -> str          # M3+
lower_c(src) -> str               # M4
```
### §10.1 Canonical AST (exact-compared as canonical JSON)
```
module : {"type":"module","body":[item…]}
v1     : {"type":"v1","verb":V,"object":O,"value":s|null,"props":{k:v…},
          "tail": null | {"dir":"TO"|"FROM","object":O,"name":s|null}}
program: {"type":"program","name":s|null,"props":{k:v…},"body":[stmt…]}
let    : {"type":"let","cell":s,"expr":E}      emit: {"type":"emit","expr":E}
read   : {"type":"read","cell":s}              label:{"type":"label","name":s}
jump   : {"type":"jump","name":s}
branch : {"type":"branch","cond":E,"then":s,"else":s|null}
loop   : {"type":"loop_while","cond":E,"body":[stmt…]}
call   : {"type":"call","program":s,"args":{cell:E…},"into":s|null}
return : {"type":"return","expr":E|null}
E      : {"int":n} | {"str":s} | {"cell":s} | {"op":OP,"args":[E…]}
```
Verb/object are canonical **names** (post-alias, §1.2); element numbers belong to a table integration, not to this AST. Compile errors: `parse` raises (any exception; the message should name the reason).

### §10.2 Milestones (cumulative; the referee gates on them)
- **M1 parser** — all `kind:"parse"` tests: v1 compat (incl. the SET trap), a full v2 block, and every fail-closed case (unknown verb, bare cell, default-profile loop rejection).
- **M2 pure executor** — all `kind:"run"`+`kind:"gate"` tests: arithmetic, interpolation, branching, loop, Minsky, strings, CALL/recursion, traps, refusal, not-eval, and the `not_wired` receipt discipline.
- **M3 → Python** — `lower_python` output, executed with `python -I`, reproduces M2 byte-identically.
- **M4 → C** — static checks: `int main` present; effectful programs reserve the `extern alcor_gate_effect_v1` ABI but remain runtime-refused.

## §11 Open questions
1. Fuel default `10^7` with `fuel=0` to lift: the spec keeps this setting; a host may still cap it (`run_hosted` always does).
2. `$cell` interpolation in TO/FROM filenames is **forbidden** in this spec (path-injection risk). Lifting that needs a design for escaping and for what a receipt records.

## Appendix A — worked example (arith + call)
```
PROGRAM Main
LET $n 7
CALL Double WITH $x=$n INTO $r
EMIT $r
END PROGRAM
PROGRAM Double
LET $y MUL $x 2
RETURN $y
END PROGRAM
```
CALL args are `cell=expr`: `$x=$n` evaluates `$n` in the caller and binds the callee frame's `$x`. Output: `14`.

## §12 INCLUDE

`INCLUDE "name.alcor"` on its own line at module level splices a library file into the
module before the lexer runs. Fail-closed on every edge:

- The host must grant an include root (`parse(src, base_dir=...)`); bare text may not
  reach the filesystem by mentioning a filename.
- A library name is a bare lowercase `.alcor` filename: no path separators, no dots
  except the extension. Symlink escapes are caught by realpath containment.
- The library is judged **alone** before it may join: parsed as a standalone module,
  every block named, every block bare of props. A standalone module with no entry props
  is default-profile, so a library is provably halting whatever includes it — an
  INCLUDE can never raise a profile, smuggle authority or fuel, or bring a loop.
- Cycles refused, nesting capped at 4, libraries capped at 64 KB.
- One compilation pins the first UTF-8 bytes read from each canonical realpath.
  Every library is validated independently with its complete dependency closure,
  while final emission is path-idempotent: a shared leaf in a diamond graph is
  emitted once. An active-stack repeat is still a cycle and is refused before
  idempotence is considered.
- Include budgets count UTF-8 bytes and include-line occurrences. Invalid UTF-8
  fails closed; both LF and CRLF module files are accepted.
- The word INCLUDE inside a string is just a string.
