# labelrelay configuration

The configuration is a JSON object. Error messages start with the path of the
offending value: top-level keys by name, list items as `printers[0]` (0-based),
nested keys joined with `.`, e.g. `printers[1].port` or `retry.attempts`.
`<path>` below stands for that path.

Anywhere in the document, a required key that is missing gives
`<path>: required` (e.g. `queue_name: required`, `printers[0].media: required`)
instead of the rule message, and a key that the tables don't list gives
`<path>: unknown key` (e.g. `colour: unknown key`, `retry.jitter: unknown key`).

"Integer" means a JSON integer; `true`/`false` are never accepted as numbers.
"Number" means an integer or a float. A key whose value is `null` counts as
present and must follow its rule.

## Top level

| key | required | rule | message when broken |
| --- | --- | --- | --- |
| `queue_name` | yes | non-empty string | `queue_name: must be a non-empty string` |
| `printers` | yes | non-empty list of printer objects | `printers: must be a non-empty list` |
| `retry` | no | object, see below | `retry: must be an object` |
| `default_printer` | no | string that is the `name` of one of the printers | `default_printer: must be a string` / `default_printer: unknown printer 'NAME'` |

## Printer objects (`printers[i]`)

An item that is not an object gives `printers[i]: must be an object`, and its
contents are not checked further.

| key | required | rule | message when broken |
| --- | --- | --- | --- |
| `name` | yes | non-empty string, unique among printers | `<path>: must be a non-empty string` / `<path>: duplicate name 'NAME'` |
| `host` | yes | non-empty string | `<path>: must be a non-empty string` |
| `port` | no (default 9100) | integer from 1 to 65535 | `<path>: must be an integer between 1 and 65535` |
| `media` | yes | one of `label-2x1`, `label-4x6`, `letter` | `<path>: must be one of label-2x1, label-4x6, letter` |

The duplicate-name message is reported on every printer after the first one
that uses that name (names are compared exactly).

## `retry`

| key | required | rule | message when broken |
| --- | --- | --- | --- |
| `attempts` | no | integer from 0 to 10 | `retry.attempts: must be an integer between 0 and 10` |
| `backoff_s` | no | number >= 0 | `retry.backoff_s: must be a number >= 0` |

## `default_printer`

Only checked against printer names when `printers` is a non-empty list (even
if some of its items have errors);
the names are those of the printer objects whose `name` is a string.
