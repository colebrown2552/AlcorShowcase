Ops wants a per-interval traffic summary of the package mirror's access log. `bucket_report.py` has the argument parsing but nothing else. Please implement it. The log format and a line parser are in `mirrorlog/parse.py`; note that lines whose BYTES field is `-` are currently rejected by the parser, but they are valid requests that sent 0 bytes.

Interface: `python3 bucket_report.py LOGFILE [--bucket SIZE]`, CSV on stdout, exit 0.

- `SIZE` is a positive whole number followed by `m` (minutes) or `h` (hours): `1m`, `5m`, `15m`, `1h`, `6h`. Default `5m`. Anything else (`0m`, `90s`, `5`, `m`, `1.5h`) prints a message containing `invalid bucket size` to stderr and exits with status 2.
- Buckets are aligned to whole multiples of SIZE counted from 1970-01-01T00:00:00Z, so `15m` buckets start at :00, :15, :30, :45 and `1h` buckets on the hour. A request belongs to the bucket containing its timestamp.
- Output header: `bucket_start,requests,errors,bytes,max_ms`, then one row per bucket from the earliest to the latest bucket that has any request, in time order, including empty buckets in between (written with all four numbers `0`).
  - `bucket_start`: the bucket's start, formatted like `2026-03-14T09:15:00Z`.
  - `requests`: number of requests; `errors`: number with status 500 or higher; `bytes`: sum of BYTES; `max_ms`: the largest SECONDS in the bucket in milliseconds, rounded to the nearest integer.
- Log lines are not guaranteed to be in time order.
- Blank lines (empty or whitespace only) are ignored. Other lines that don't parse are skipped; if any were skipped, print `skipped N malformed lines` to stderr (still exit 0).
- An empty log, or one with no valid lines, outputs only the header.

For `samples/access.log` with the default size, the output is:

```
bucket_start,requests,errors,bytes,max_ms
2026-03-14T09:00:00Z,3,0,36224,41
2026-03-14T09:05:00Z,0,0,0,0
2026-03-14T09:10:00Z,1,1,312,1250
2026-03-14T09:15:00Z,1,0,0,2
```

and `skipped 1 malformed lines` on stderr. Done means the report is right for any log and bucket size.
