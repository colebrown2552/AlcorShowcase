# AlcorLang v3 — structured syntax and portable directives

**Status:** preview frontend over AlcorLang v2

**Version:** `3.0.0-preview.1`
**Execution semantics:** unchanged AlcorLang v2 / ALCORCORE

## 0. Purpose

AlcorLang v2 established the execution core: one canonical IR, an interpreter,
Python and C lowerings, a default halting profile, an authority-gated complete
profile, and one gate instruction for every effect. v3 does not create a second
runtime. It makes that core easier to write and adds the portable `.alcor.*`
control vocabulary that Alcor clients can translate into provider-specific
requests.

The compiler relation is:

```text
AlcorLang v3 source
        |
        | deterministic, source-to-source lowering
        v
canonical AlcorLang v2 source
        |
        v
ALCORCORE -> interpreter | Python | C
```

If v3 cannot lower a construct without preserving v2's safety invariants, it
rejects the source.

## 1. Dispatch and compatibility

A source without a leading v3 marker is returned byte-for-byte to the v2
implementation, even when its text resembles a v3 construct. Existing v1 and v2
programs therefore keep their current meaning and are never selected by syntax
guessing.

A v3 file may begin with one of:

```text
ALCOR 3
ALCORLANG 3
#!ALCOR 3
```

The marker is required. It must be the first meaningful line; blank lines and
comments may precede it. A marker elsewhere has no v3 meaning because dispatch
has already selected the byte-for-byte v2 path.

A v3 file may contain one or more canonical `PROGRAM ... END PROGRAM` blocks.
When no block exists, v3 wraps the statements in `PROGRAM Program`. Top-level
statements may not be mixed with explicit program blocks because v2 currently has
no execution semantics for that mixed module shape.

## 2. Structured statements

The following statements are v3 sugar:

```bnf
assignment  ::= cell "=" infix_expr
              | "LET" cell "=" infix_expr
print       ::= "PRINT" infix_expr
input       ::= "INPUT" cell
if          ::= "IF" infix_expr "THEN" NL statements
               ["ELSE" NL statements]
               "END" "IF"
for         ::= "FOR" cell "FROM" infix_expr "TO" infix_expr
               ["STEP" integer_literal] NL statements
               "END" "FOR"
```

Canonical v2 statements remain legal in a v3 file and are passed to the v2 parser
as the final authority.

### 2.1 Assignment, print, and input

```text
$x = 2 + 3 * 4       -> LET $x ADD 2 MUL 3 4
PRINT $x             -> EMIT $x
INPUT $line          -> READ $line
```

### 2.2 IF

`IF` lowers only to forward labels and jumps. It is therefore legal in the
`default` profile and preserves the finite-DAG guarantee.

```text
IF $score >= 90 THEN
  PRINT "pass"
ELSE
  PRINT "retry"
END IF
```

becomes the canonical shape:

```text
BRANCH GE $score 90 <then> ELSE <else>
LABEL <then>
EMIT "pass"
JUMP <end>
LABEL <else>
EMIT "retry"
LABEL <end>
```

Generated labels are program-local, unique, and valid v2 label names.

### 2.3 FOR

`TO` is inclusive. `STEP` defaults to `1` and must be a non-zero integer literal.
The induction cell is initialized to the start value even when the loop is empty.
After a non-empty loop it contains the first stepped value beyond the inclusive
bound. The compiler controls that cell between iterations, so an assignment to it
inside the body cannot change the trip count or its post-loop value. Static and
dynamic lowerings share this contract.

When start and end are integer literals, the frontend expands the loop at compile
time. The expansion is limited to 1,000 iterations. This gives the default
profile a useful bounded loop without weakening its halting proof.

When either bound is dynamic, the frontend lowers the loop to a backward jump.
The v2 parser therefore rejects it under `profile=default`; it is available only
through the existing authority-gated `complete` profile.

```text
FOR $i FROM 1 TO 3
  PRINT $i
END FOR
```

is statically expanded. In contrast:

```text
PROGRAM Dynamic WITH profile=complete authority=conformance
FOR $i FROM 1 TO $last
  PRINT $i
END FOR
END PROGRAM
```

lowers to a test label, a body label, an increment, and a backward jump. Hosted
execution must not accept `authority=conformance`; that remains sandbox-only as
specified by v2.

## 3. Infix expressions

v3 expressions are deterministic and lower to v2 prefix expressions.

### 3.1 Values

```bnf
value ::= integer | json_string | cell | "true" | "false" | "(" expr ")"
```

Boolean literals lower to pure v2 comparisons (`EQ 1 1` and `EQ 1 0`) because v2
has no separate boolean literal syntax.

### 3.2 Operators

From lowest to highest precedence:

| Precedence | v3 | v2 |
|---|---|---|
| 10 | `||` | `OR` |
| 20 | `&&` | `AND` |
| 30 | `==`, `!=` | `EQ`, `NE` |
| 40 | `<`, `<=`, `>`, `>=` | `LT`, `LE`, `GT`, `GE` |
| 45 | `++` | `CAT` |
| 50 | `+`, `-` | `ADD`, `SUB` |
| 60 | `*`, `/`, `%` | `MUL`, `DIV`, `MOD` |
| 70 | unary `!`, unary `-` | `NOT`, `NEG` |

`/` inherits v2's floor-division semantics. `++` is string concatenation and
inherits v2's type checks. Chained comparisons such as `a < b < c` are rejected;
write `a < b && b < c` so the lowering is explicit.

Supported functions are `len(x)`, `str(x)`, `int(x)`, `cat(a,b)`, `add(a,b)`,
`sub(a,b)`, `mul(a,b)`, `div(a,b)`, and `mod(a,b)`. Unknown identifiers and wrong
arities fail closed. The parser never uses `eval` or `exec`.

## 4. Portable `.alcor.*` directives

### 4.1 Forms

```bnf
directive   ::= ".alcor." name ["(" [arguments] ")"]
arguments   ::= argument {"," argument}
argument    ::= value | key "=" value
value       ::= json_string | number | true | false | null
              | array | object | token_reference | symbolic_atom
token_reference ::= ".alcor." name
```

Strings follow JSON escaping. Arrays and objects are JSON-like. Numbers must be
finite and payloads serialize as strict canonical JSON (`NaN` and infinities are
rejected). Bare identifiers are inert symbolic atoms such as `auto`, `local`, or
`cheap`; they are never looked up or executed.

### 4.2 Closed directive set

The preview recognizes:

```text
goal model thread list select run stop status history template context memory
capabilities source target translate compile
```

Unknown names fail closed.

The first thirteen names (`goal` through `capabilities`) are the portable
control vocabulary: local-first goals, model selection, logical threads,
status/history, templates, context budgets, and memory bindings. `source`,
`target`, `translate`, and `compile` are the first language-neutral primitives;
`programs/translate_request.alcor` uses them.

### 4.3 Lowered descriptor

Each directive becomes one embedded v1 statement and therefore one ALCORCORE
`EFFECT` instruction:

```text
Update Task "<canonical JSON payload>"
  WITH directive=<name> schema=alcor.directive.v1 mode=<bind|query|action>
```

Query directives use `View Task`; all others use `Update Task`. The canonical JSON
payload is:

```json
{
  "schema": "alcor.directive.v1",
  "name": "run",
  "args": [],
  "kwargs": {
    "model": "local:auto",
    "prompt": "hello",
    "stream": true
  }
}
```

A token reference is data:

```json
{"token_ref":"alcor.thread"}
```

It is not variable interpolation and is never executed by this frontend.

### 4.4 Semantic validation

Validation is staged:

1. lexical validity;
2. grammar and closed-token validity;
3. source semantics;
4. the existing v2 parser and profile checks;
5. adapter policy at the gate.

The frontend enforces:

- source size at most 1 MiB;
- at most 128 directive statements and at most 128 lowered directive attempts per
  program; both branch arms and every compile-time-unrolled copy count;
- nesting depth at most 8;
- bounded strings, arrays, and objects;
- `.alcor.thread` accepts exactly one literal string ID, either positional or
  `id=...`, with no extra keys, absolute paths, or traversal;
- context limits (`max_input <= 1,000,000`, `max_output <= 100,000`);
- no credential-shaped keys such as `api_key`, `token`, `secret`, `password`,
  `authorization`, cookies, or private keys;
- `.alcor.run` has a resolved model or profile;
- `.alcor.translate` has resolved source and target bindings;
- `.alcor.compile` has a target;
- token references resolve only to bindings established on every reaching path;
- positional arguments may not follow keyword arguments;
- credential-shaped keys are rejected recursively inside arrays and objects;
- branch bindings are conservative: a binding is available after `IF` only when
  both branches establish it.

Adapter availability, model existence, capability negotiation, network and
filesystem allowlists, confirmations, and credentials remain gate/adapter
responsibilities. Source text never grants those capabilities.

## 5. Security invariants

v3 preserves the v2 invariants:

1. one runtime and one IR; no competing interpreter;
2. all effects lower to `EFFECT` and route through the existing gate;
3. each directive attempt is separately receipted by the host adapter;
4. the default profile still halts by construction;
5. dynamic loops still require complete-profile authority;
6. no `eval` or `exec`;
7. interpolation remains inert data under the v2 rules;
8. credentials stay outside source and prompt context;
9. directives describe intent but grant no effect authority.

## 6. API and CLI

The `alcorlang.v3` package mirrors v2:

```python
transpile(src) -> str
expand(src) -> str              # compatibility alias for transpile
parse(src, base_dir=None) -> dict
compile_core(src, base_dir=None) -> Core
run(src, input_text="", base_dir=None) -> str
lower_python(src, base_dir=None) -> str
lower_c(src, base_dir=None) -> str
parse_directives(line) -> list[Directive]
compile_expression(text) -> str   # infix -> v2 prefix
```

The top-level `alcorlang` functions (`run`, `parse`, `lower_python`, ...) accept v3 sources
directly, because the v2 core transpiles any source that carries a v3 marker.

CLI (`python -m alcorlang ...`):

```text
transpile FILE|-         v3 -> canonical v2 source
ast       FILE|-         the checked v2 AST as JSON
run       FILE|- [--input FILE | --input-text TEXT]
lower     FILE|- --target python|c
directives FILE|-        the .alcor.* payloads as JSON
```

The `ast`, `run`, and `lower` commands always transpile first and then delegate to v2.

## 7. Non-goals of this slice

- No provider adapter is embedded in the language frontend.
- No credentials are accepted.
- No filesystem, process, network, model, or connector action occurs while parsing
  or transpiling.
- No list/map runtime type is added to ALCORCORE; JSON-like values exist inside
  directive payloads only.
- No exception recovery or trap-catching syntax is added.
- No change is made to the v2 vocabulary table.

## 8. Conformance

The existing v2 corpus remains authoritative for execution semantics. v3 adds a
separate frontend test suite (`tests/test_alcorlang_v3.py`) covering directives,
validation, expression precedence, control-flow lowering, conservative bindings,
bounded unrolling, label hygiene, pass-through compatibility, and delegation to every
v2 backend.
