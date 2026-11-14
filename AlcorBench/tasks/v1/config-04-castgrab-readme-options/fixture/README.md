# castgrab

Downloads new episodes of the podcasts listed in a feeds file, one feed URL per
line. Used to fill the offline listening shelf at the Fennick Street library branch.

## Install

Copy the `castgrab` folder somewhere on `PYTHONPATH`; it has no dependencies.

## Usage

    python3 -m castgrab.cli feeds.txt [OPTIONS]

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--download-dir` | `downloads` | Where episode files are saved. |
| `--max-episodes` | `5` | Newest episodes to fetch per feed. |
| `--rename` | `true` | Rename files to DATE-TITLE.EXT. |
| `--date-format` | `%Y%m%d` | Date format used in renamed files. |
| `--user-agent` | `castgrab/1` | User-Agent header sent to feed servers. |
| `--timeout` | `30` | Seconds to wait for a server. |
| `--trace-http` | `false` | Dump raw HTTP exchanges. |
| `--verbose` | `false` | Print every request. |

## Feeds file

Blank lines and lines starting with `#` are ignored.
