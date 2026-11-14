Marketing wants to reuse our notification templates for subject lines, which needs a few formatting filters. Please add a filter pipeline to `minitpl` (`minitpl/render.py`).

**Syntax:** `{{ expr | filter | filter:arg }}`. `expr` is the existing variable lookup (dotted names allowed). Filters are separated by `|`, applied left to right, and whitespace around `|` and around the whole tag is optional (`{{name|upper}}` works).

**Value going into the chain:** the variable converted to a string the way it is today (`None` becomes `""`, other values go through `str()`).

**Filters:**

| filter | result |
|---|---|
| `upper` | the value upper-cased |
| `lower` | the value lower-cased |
| `default:"text"` | `text` if the value is the empty string, otherwise the value unchanged |
| `truncate:N` | if the value is longer than `N` characters, its first `N` characters followed by `...`; otherwise unchanged. `N` is a non-negative integer literal |

- `default` takes a double-quoted string argument (it may contain spaces and `:` but never `"` or `|`); `truncate` takes an integer. `upper`/`lower` take no argument.
- **Missing variables:** still raise `TemplateError`, unless `default` appears anywhere in that tag's filter chain; then the missing value starts as `""` and runs through the chain like any other value.
- Raise `TemplateError` for an unknown filter name, a missing or wrong-typed argument (`truncate:"5"`, `truncate:-1`, `default:3`, bare `default`), or an argument given to `upper`/`lower`.
- Templates without filters render exactly as before.

Examples:

- `{{ user.name | upper }}` with name `"Ada"` -> `ADA`
- `{{ promo | default:"none" }}` with `promo` missing -> `none`
- `{{ title | truncate:4 }}` with `"Release"` -> `Rele...`

The tests in `tests/test_render.py` must keep passing; don't change them. Keep it standard library only.
