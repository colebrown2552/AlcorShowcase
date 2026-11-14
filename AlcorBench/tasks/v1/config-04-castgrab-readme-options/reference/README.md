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
| `--version` | `-` | Print the version and exit. |
| `--download-dir` | `episodes` | Where episode files are saved. |
| `--max-episodes` | `10` | Newest episodes to fetch per feed. |
| `--min-free-mb` | `500` | Stop downloading below this much free disk space. |
| `--rename` | `false` | Rename files to DATE-TITLE.EXT. |
| `--name-template` | `{date}-{title}` | Pattern used by `--rename`. |
| `--user-agent` | `castgrab/2` | User-Agent header sent to feed servers. |
| `--timeout` | `30.0` | Seconds to wait for a server. |
| `--skip-older-than` | `-` | Ignore episodes older than this many days. |
| `--keep-partial` | `false` | Keep partly downloaded files after an error. |
| `--config` | `castgrab.ini` | Settings file to read first. |
| `--quiet` | `false` | Only print errors. |

## Feeds file

Blank lines and lines starting with `#` are ignored.
