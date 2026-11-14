"""Summarise the mirror access log per time interval (CSV on stdout)."""
import argparse
import sys

from mirrorlog.parse import parse_request


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logfile")
    parser.add_argument("--bucket", default="5m")
    args = parser.parse_args(argv)
    raise NotImplementedError("bucket report")


if __name__ == "__main__":
    sys.exit(main())
