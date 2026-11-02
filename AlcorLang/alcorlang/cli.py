"""The ``python -m alcorlang`` command line.

One entry point over every tool in the package:

====================  ==============================================================
command               what it does
====================  ==============================================================
``run``               execute a program and print its output tape
``check``             parse, run the static checks and compile; print a summary
``lint``              diagnostics with stable rule ids (``alcor.lint.v1``)
``audit``             lint every ``.alcor`` file under a directory
``lower``             emit standalone Python or C for a program
``transpile``         lower v3 syntax to canonical v2 source
``ast``               print the canonical AST as JSON
``directives``        print the ``.alcor.*`` directive payloads of a v3 source
``native``            C-compiler driver: inspect, build, run, asm
``conformance``       judge this package against the conformance corpus
``host``              run a program on the interpreter written in AlcorLang
``selftest``          the in-process checks
``table``             the vocabulary in force
====================  ==============================================================

Exit status is 0 on success and 1 on any rejection, failed check or lint error (lint warnings
fail only with ``--strict``).  Diagnostics go to stderr; program output goes to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from . import lint, native, referee, selfhost
from .core import compile_core, parse, transpile
from .errors import AlcorLangError
from .lowering import lower_c, lower_python
from .machine import run, run_metered
from .selftest import selftest
from .v3.common import AlcorLangV3Error, logical_lines
from .v3.directives import parse_directives
from .vocabulary import table


def _read_text(path: str) -> str:
    """Read a UTF-8 text file, or stdin when ``path`` is ``-``.

    A leading byte-order mark is dropped, because several Windows editors and shells add one
    and the language itself (rightly) rejects it as an unknown character.
    """
    text = sys.stdin.read() if path == "-" else Path(path).expanduser().read_text(encoding="utf-8")
    return text.removeprefix("﻿")


def _source_with_root(path: str) -> tuple[str, str | None]:
    """Read a program and work out its include root (its own directory, none for stdin)."""
    source = _read_text(path)
    if path == "-":
        return source, None
    return source, str(Path(path).expanduser().resolve().parent)


def _cmd_run(args: argparse.Namespace) -> int:
    source, base_dir = _source_with_root(args.source)
    if args.input_text is not None:
        input_text = args.input_text
    else:
        input_text = _read_text(args.input) if args.input else ""
    if args.metered:
        report = run_metered(source, input_text, base_dir=base_dir)
        sys.stdout.write(report["tape"])
        print(
            f"alcorlang: steps={report['steps']} fuel={report['fuel']} "
            f"headroom={report['headroom']} profile={report['profile']}",
            file=sys.stderr,
        )
        return 0
    sys.stdout.write(run(source, input_text, base_dir))
    return 0


def _cmd_check(args: argparse.Namespace) -> int:
    source, base_dir = _source_with_root(args.source)
    core = compile_core(source, base_dir)
    blocks = core.ordered_blocks()
    instructions = sum(len(block.code) for block in blocks)
    effects = sum(1 for block in blocks for ins in block.code if ins[0] == "EFFECT")
    verdict = "refused-at-run" if core.refused() else "runnable"
    print(
        f"ok  {args.source}  profile={core.profile}  blocks={len(blocks)}  "
        f"instructions={instructions}  effects={effects}  {verdict}"
    )
    return 0


def _cmd_ast(args: argparse.Namespace) -> int:
    source, base_dir = _source_with_root(args.source)
    print(json.dumps(parse(source, base_dir), indent=2, sort_keys=True))
    return 0


def _cmd_transpile(args: argparse.Namespace) -> int:
    sys.stdout.write(transpile(_read_text(args.source)))
    return 0


def _cmd_lower(args: argparse.Namespace) -> int:
    source, base_dir = _source_with_root(args.source)
    lowering = lower_python if args.target == "python" else lower_c
    sys.stdout.write(lowering(source, base_dir))
    return 0


def _cmd_directives(args: argparse.Namespace) -> int:
    payloads: list[dict[str, Any]] = []
    for line in logical_lines(_read_text(args.source)):
        if line.startswith(".alcor."):
            payloads.extend(directive.payload() for directive in parse_directives(line))
    print(json.dumps(payloads, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def _emit_report(report: dict[str, Any], args: argparse.Namespace) -> int:
    """Print a lint report in the requested format and return the exit status."""
    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        sys.stdout.write(lint.format_human(report))
    return lint.exit_code(report, args.strict)


def _cmd_lint(args: argparse.Namespace) -> int:
    if args.source == "-":
        base_dir = str(Path(args.base_dir).expanduser().resolve()) if args.base_dir else None
        report = lint.lint_source(
            _read_text("-"), path="<stdin>", base_dir=base_dir, disabled_rules=args.disable
        )
    else:
        report = lint.lint_file(args.source, disabled_rules=args.disable)
    return _emit_report(report, args)


def _cmd_audit(args: argparse.Namespace) -> int:
    return _emit_report(lint.audit(args.root, disabled_rules=args.disable), args)


def _cmd_native(args: argparse.Namespace) -> int:
    cache_dir = Path(args.cache_dir) if args.cache_dir else native.default_cache_dir()
    source, base_dir = native.read_source(args.source)
    if args.action == "inspect":
        print(json.dumps(native.inspect_source(source, base_dir), indent=2, sort_keys=True))
    elif args.action == "asm":
        report = native.emit_assembly(source, Path(args.output), base_dir)
        print(json.dumps(report, indent=2, sort_keys=True))
    elif args.action == "build":
        built = native.build_native(source, base_dir, cache_dir)
        if args.output:
            built = dict(built, copied_to=str(native.copy_native(built, Path(args.output))))
        summary = {key: value for key, value in built.items() if key != "inspection"}
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        if args.source == "-" and args.input == "-":
            raise native.AlcorCompilerError("stdin cannot supply both source and native input")
        built = native.build_native(source, base_dir, cache_dir)
        stdout, stderr, returncode = native.run_native(
            built, native.read_input(args.input), args.timeout
        )
        if stderr:
            sys.stderr.buffer.write(stderr)
        sys.stdout.buffer.write(stdout)
        if returncode != 0:
            raise native.AlcorCompilerError(f"native program exited with status {returncode}")
    return 0


def _cmd_conformance(args: argparse.Namespace) -> int:
    impl_dir = Path(__file__).resolve().parents[1]
    corpus = json.loads(Path(args.tests).read_text(encoding="utf-8"))
    tests = referee.select_tests(corpus, args.milestone)
    report = referee.run_conformance(impl_dir, args.milestone, tests, args.timeout)
    if args.json:
        report = {key: value for key, value in report.items() if key != "impl"}
        print(json.dumps(report, indent=2))
    else:
        referee.print_report(report)
    return 0 if report["all_pass"] else 1


def _cmd_host(args: argparse.Namespace) -> int:
    if args.sweep:
        counts, mismatches = selfhost.sweep(args.stride)
        total = sum(counts.values())
        detail = ", ".join(f"{kind}={count}" for kind, count in sorted(counts.items()))
        print(f"operator sweep: {total} programs; {detail}; mismatches={len(mismatches)}")
        for guest, verdict in mismatches[:10]:
            print(
                f"  MISMATCH {guest!r}: reference={verdict.reference!r} hosted={verdict.hosted!r}"
            )
        return 0 if not mismatches else 1
    if args.source is None:
        raise AlcorLangError("host needs a source file, or --sweep")
    source = _read_text(args.source)
    input_text = _read_text(args.input) if args.input else ""
    verdict = selfhost.compare(source, input_text)
    sys.stdout.write(verdict.hosted)
    print(
        f"alcorlang: self-hosted run is {verdict.kind} ({verdict.host_steps} host steps)",
        file=sys.stderr,
    )
    return 0 if verdict.agrees else 1


def _cmd_selftest(args: argparse.Namespace) -> int:
    return selftest()


def _cmd_table(args: argparse.Namespace) -> int:
    print(json.dumps(table(), indent=2))
    return 0


def _add_lint_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--format", choices=("human", "json"), default="human")
    parser.add_argument("--strict", action="store_true", help="exit 1 on warnings too")
    parser.add_argument(
        "--disable",
        action="append",
        default=[],
        metavar="RULE",
        help="switch off a rule id or a family such as source/* (parse/* cannot be disabled)",
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser for every command."""
    parser = argparse.ArgumentParser(
        prog="python -m alcorlang",
        description="AlcorLang: parse, check, run, lint and lower .alcor programs.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="command")

    def add(name: str, handler: Callable[[argparse.Namespace], int], help_text: str) -> Any:
        sub = commands.add_parser(name, help=help_text, description=help_text)
        sub.set_defaults(handler=handler)
        return sub

    sub = add("run", _cmd_run, "execute a program and print its output tape")
    sub.add_argument("source", help="a .alcor file, or - for stdin")
    sub.add_argument("--input", metavar="FILE", help="file whose lines feed READ")
    sub.add_argument("--input-text", metavar="TEXT", help="literal text whose lines feed READ")
    sub.add_argument("--metered", action="store_true", help="report steps and fuel on stderr")

    sub = add("check", _cmd_check, "parse, check and compile; print a one-line summary")
    sub.add_argument("source", help="a .alcor file, or - for stdin")

    sub = add("lint", _cmd_lint, "diagnostics with stable rule ids")
    sub.add_argument("source", help="a .alcor file, or - for stdin")
    sub.add_argument("--base-dir", help="include root for stdin (default: none)")
    _add_lint_options(sub)

    sub = add("audit", _cmd_audit, "lint every .alcor file under a directory")
    sub.add_argument("root", help="a directory, or one .alcor file")
    _add_lint_options(sub)

    sub = add("lower", _cmd_lower, "emit standalone Python or C for a program")
    sub.add_argument("source", help="a .alcor file, or - for stdin")
    sub.add_argument("--target", choices=("python", "c"), default="python")

    sub = add("transpile", _cmd_transpile, "lower v3 syntax to canonical v2 source")
    sub.add_argument("source", help="a .alcor file, or - for stdin")

    sub = add("ast", _cmd_ast, "print the canonical AST as JSON")
    sub.add_argument("source", help="a .alcor file, or - for stdin")

    sub = add("directives", _cmd_directives, "print the .alcor.* directive payloads as JSON")
    sub.add_argument("source", help="a v3 .alcor file, or - for stdin")

    sub = add("native", _cmd_native, "C-compiler driver: inspect, build, run or emit assembly")
    sub.add_argument("action", choices=("inspect", "build", "run", "asm"))
    sub.add_argument("source", help="a .alcor file, or - for stdin")
    sub.add_argument("-o", "--output", help="output path (asm requires it; build copies there)")
    sub.add_argument("--input", help="stdin for the native program: a file, or -")
    sub.add_argument("--timeout", type=float, default=native.DEFAULT_TIMEOUT)
    sub.add_argument("--cache-dir", help="where built binaries are cached")

    sub = add("conformance", _cmd_conformance, "judge this package against the corpus")
    sub.add_argument("--milestone", choices=referee.MILESTONES, default="M4")
    sub.add_argument("--tests", default=str(referee.DEFAULT_TESTS), help="corpus JSON file")
    sub.add_argument("--timeout", type=float, default=referee.DEFAULT_TIMEOUT)
    sub.add_argument("--json", action="store_true", help="machine-readable output")

    sub = add("host", _cmd_host, "run a program on the interpreter written in AlcorLang")
    sub.add_argument("source", nargs="?", help="a .alcor file, or - for stdin")
    sub.add_argument("--input", metavar="FILE", help="file whose lines feed READ")
    sub.add_argument(
        "--sweep", action="store_true", help="compare both interpreters on every operator"
    )
    sub.add_argument("--stride", type=int, default=1, help="with --sweep: take every Nth program")

    add("selftest", _cmd_selftest, "run the in-process checks")
    add("table", _cmd_table, "print the vocabulary in force")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command line and return the process exit status."""
    # Programs may EMIT any Unicode text, and a legacy console code page would raise on it.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        return args.handler(args)
    except (AlcorLangError, AlcorLangV3Error, native.AlcorCompilerError, OSError) as exc:
        print(f"alcorlang: {exc}", file=sys.stderr)
        return 1
