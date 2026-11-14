"""Command-line options shared by the castgrab commands."""
from collections import namedtuple

Option = namedtuple("Option", "flags kind default help hidden")


def opt(*flags, kind="str", default=None, help="", hidden=False):
    return Option(flags, kind, default, help, hidden)


OPTIONS = [
    opt("-d", "--download-dir", default="episodes", help="Where episode files are saved."),
    opt("-n", "--max-episodes", kind="int", default=10, help="Newest episodes to fetch per feed."),
    opt("--min-free-mb", kind="int", default=500, help="Stop downloading below this much free disk space."),
    opt("--rename", kind="flag", default=False, help="Rename files to DATE-TITLE.EXT."),
    opt("--name-template", default="{date}-{title}", help="Pattern used by --rename."),
    opt("--user-agent", default="castgrab/2", help="User-Agent header sent to feed servers."),
    opt("--timeout", kind="float", default=30.0, help="Seconds to wait for a server."),
    opt("--skip-older-than", kind="int", default=None, help="Ignore episodes older than this many days."),
    opt("--keep-partial", kind="flag", default=False, help="Keep partly downloaded files after an error."),
    opt("--trace-http", kind="flag", default=False, help="Dump raw HTTP exchanges.", hidden=True),
]
