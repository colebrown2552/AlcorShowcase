"""castgrab: download new podcast episodes listed in a feeds file."""
import argparse

from castgrab import __version__
from castgrab.options import OPTIONS

TYPES = {"str": str, "int": int, "float": float}


def build_parser():
    parser = argparse.ArgumentParser(prog="castgrab", description=__doc__)
    parser.add_argument("feeds_file", help="Text file with one feed URL per line.")
    parser.add_argument("--version", action="version", version="castgrab " + __version__)
    for option in OPTIONS:
        if option.kind == "flag":
            kwargs = {"action": "store_true", "default": option.default}
        else:
            kwargs = {"type": TYPES[option.kind], "default": option.default}
        kwargs["help"] = argparse.SUPPRESS if option.hidden else option.help
        parser.add_argument(*option.flags, **kwargs)
    parser.add_argument("--config", default="castgrab.ini", help="Settings file to read first.")
    parser.add_argument("-q", "--quiet", action="store_true", help="Only print errors.")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args


if __name__ == "__main__":
    main()
