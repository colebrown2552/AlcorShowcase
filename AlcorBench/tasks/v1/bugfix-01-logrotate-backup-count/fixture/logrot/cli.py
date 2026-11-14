import argparse
import sys

from logrot.rotator import rotate, should_rotate


def main(argv=None):
    parser = argparse.ArgumentParser(description="Rotate a log file by size.")
    parser.add_argument("path")
    parser.add_argument("--max-bytes", type=int, default=10 * 1024 * 1024)
    parser.add_argument("--backups", type=int, default=5)
    parser.add_argument("--force", action="store_true", help="rotate regardless of size")
    args = parser.parse_args(argv)
    if args.force or should_rotate(args.path, args.max_bytes):
        rotate(args.path, args.backups)
        print(f"rotated {args.path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
