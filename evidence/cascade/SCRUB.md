# Scrub notes

`data/replays.json` holds the review cascade's think=false rows (49 per version) from four calibration runs, v1 to v4 in time order. Each version also records the SHA-256 of its source file.

## Kept fields (per row, in source order)

- `id`: first 12 hex characters of sha256(salt + run name). The salt is kept outside the repository.
- `opus`: Opus verdict
- `sonnet`: Sonnet verdict
- `alcor`: Alcor verdict
- `think`: thinking mode flag (always false here)
- `error`: true when the source error was non-null (the error text is not kept)
- `blocks`: number of blocking findings
- `matched_opus`: blocking findings that matched an Opus problem
- `dropped`: findings dropped as unverified

## Dropped fields

- `run` (run name), `node` (node name), `attempt`
- `error` text (replaced by the boolean)
- `findings` (all of it: severity, check, where, why, fix, quote)
- `seconds`, `truncated`, `usage` (token and cost counts)
- All think=true rows, and the separate 2-case calibration file
- File-level fields (`utc`, `wall_seconds`, `cases`, `summary`)

## Scripts

`alcor_review.py` and `alcor_calibrate.py` are copies with the built-in router address, lane names and run/output paths replaced by environment variables (`REVIEW_ROUTER_URL`, `REVIEW_LANE`, `CALIB_RUNS`, `CALIB_OUT`, `CALIB_LANES`). With none set they call nothing.
