# Export formats

Every format registered in `reportkit/registry.py` is listed here, with all of its
options from `reportkit/config.py`.

| format | options | output |
|---|---|---|
| `csv` | `delimiter` (default `,`), `header` (default `true`) | Comma-separated values, header row first. |
| `json` | `indent` (default `2`), `sort_keys` (default `false`) | A JSON array of row objects. |

Rows are dicts; columns appear in the order keys are first seen. `None` becomes an empty cell.
