# Style and commenting standard

Every component in this repository follows the same rules, so the code reads as one body of work.
Formatting is mechanical (enforced by tools in CI); commenting is a discipline (enforced in review).

## Formatting (enforced)

| Language | Tool | Settings |
|---|---|---|
| Python 3.10+ | `ruff format`, `ruff check` | line length 100, rules in `pyproject.toml` |
| JavaScript (ES2020+, no build step) | `prettier --check` | `.prettierrc.json`: 2 spaces, single quotes, semicolons, width 100 |
| Rust (2021 edition) | `cargo fmt --check`, `cargo clippy -D warnings` | `rustfmt.toml`: width 100 |

`.editorconfig` sets UTF-8, LF line endings and a final newline everywhere.

## Commenting

The goal of a comment is to tell the reader something the code cannot: **why** it is written this way,
what must stay true, and what would break if you changed it.

1. **File header.** Every source file opens with a short header: what the file is for and how it fits
   into its component. Python uses a module docstring, JavaScript a `/** ... */` block, Rust `//!`.
2. **Public API docs.** Every public function, class, method and type is documented.
   - Python: Google style. One-line summary, then `Args:`, `Returns:` and `Raises:` when they add
     information. Type hints carry the types; the docstring carries the meaning.
   - JavaScript: JSDoc with `@param {type} name - meaning` and `@returns`.
   - Rust: `///` with a summary line, plus `# Errors` and `# Panics` sections where they apply.
3. **Inline comments explain why, not what.** Good: `// Ack before processing so a crash replays the
   message instead of losing it.` Bad: `// increment i`.
4. **Name the invariant.** When correctness depends on an ordering, a lock, an encoding or a protocol
   detail, say so where it is relied on.
5. **No dead weight.** No commented-out code, no stale TODOs, no change-log comments (git is the log).
6. **Plain English.** Short sentences, no jargon that the surrounding code doesn't define.

## Code

- Names say what a thing is: `pending_jobs`, not `pj`. Constants are `UPPER_SNAKE_CASE`.
- Fail closed: on bad input or an unexpected state, stop with a clear error instead of guessing.
- No secrets, hostnames, IP addresses, usernames or personal paths in source. Configuration comes from
  environment variables or a config file, and examples use placeholders such as `example-host`.
- Each component ships a `demo/` (or `examples/`) that runs end to end on a clean machine with no
  private infrastructure, and `scripts/check` runs every demo.
