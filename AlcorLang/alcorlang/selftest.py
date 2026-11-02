"""In-process self-check of the language: the checks a change must pass.

``selftest`` exercises the parser, the halting profile, the total operator semantics, INCLUDE,
metering, the interpolation rule and all three backends, then sweeps the parse and run halves
of the conformance corpus in-process.  It is the fast inner loop.  The referee
(``referee.py``) remains the judge, because it runs each test in its own interpreter.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from .core import compile_core, parse
from .errors import AlcorLangError
from .lowering import lower_c, lower_python
from .machine import run, run_metered
from .vocabulary import table

CORPUS_PATH = Path(__file__).resolve().parents[1] / "conformance" / "conformance_v2.json"


def selftest() -> int:
    """Run every in-process check, print a ``selftest: passed/total`` line, and return a status.

    Returns:
        0 if every check passed, 1 otherwise (each failure is printed).
    """
    checks = 0
    failed: list[str] = []

    def ok(cond: object, msg: str) -> None:
        nonlocal checks
        checks += 1
        if not cond:
            failed.append(msg)

    def raises(src: str, msg: str) -> None:
        nonlocal checks
        checks += 1
        try:
            parse(src)
        except AlcorLangError:
            return
        except Exception as exc:  # noqa: BLE001 - still a reject, but of the wrong kind
            failed.append(msg + f" (raised {type(exc).__name__}, want AlcorLangError)")
            return
        failed.append(msg + " (parsed clean)")

    # §1.1 dispatch and the §3 compat trap
    ast = parse('SET Task "x"')
    ok(
        ast["body"][0]["verb"] == "Update" and ast["body"][0]["type"] == "v1",
        "SET is the v1 Update alias, not a cell op (§3)",
    )
    ok(
        parse('WRITE Message "hi" TO File t.txt')["body"][0]["tail"]["name"] == "t.txt",
        "TO/FROM name keeps v1 greedy-join",
    )
    ok(
        parse('SEND Message "hi" TO Person ada')["body"][0]["verb"] == "Message",
        "SEND aliases to Message",
    )
    raises("FROB Task", "unknown verb must be fail-closed")
    raises('WRITE Message "a"\nOPEN File "b"', "a v1 program is exactly one statement")
    raises("PROGRAM\nLET x 5\nEND PROGRAM", "a bare identifier is not a cell")
    raises("PROGRAM\nEMIT ADD 1\nEND PROGRAM", "prefix arity is enforced")
    raises("PROGRAM\nJUMP nowhere\nEND PROGRAM", "unknown label is a compile error")
    raises("PROGRAM\nLABEL a\nLABEL a\nEND PROGRAM", "labels are unique")
    raises("PROGRAM WITH profile=weird\nEMIT 1\nEND PROGRAM", "unknown profile")
    raises("PROGRAM WITH bogus=1\nEMIT 1\nEND PROGRAM", "unknown PROGRAM property")

    # §5 halting profile, all three rejections
    raises(
        "PROGRAM\nLET $i 0\nLOOP WHILE LT $i 3\nLET $i ADD $i 1\nEND LOOP\nEND PROGRAM",
        "default profile rejects LOOP",
    )
    raises("PROGRAM\nLABEL top\nJUMP top\nEND PROGRAM", "default profile rejects a backward JUMP")
    raises("PROGRAM Main\nCALL Main INTO $r\nEND PROGRAM", "default profile rejects a call cycle")
    ok(
        parse("PROGRAM WITH profile=complete authority=conformance\nLABEL t\nJUMP t\nEND PROGRAM")[
            "body"
        ][0]["props"]["profile"]
        == "complete",
        "the complete profile accepts what default rejects",
    )

    # §5 authority is a RUN-time check: complete-without-authority must PARSE.
    unsigned = "PROGRAM WITH profile=complete\nEMIT 1\nEND PROGRAM"
    ok(isinstance(parse(unsigned), dict), "unsigned complete parses (prepared-not-run)")
    ok(run(unsigned) == "REFUSED unsigned_complete\n", "unsigned complete refuses")

    # §6.2 total semantics
    ok(run("PROGRAM\nEMIT DIV 7 2\nEND PROGRAM") == "3\n", "DIV floors")
    ok(run("PROGRAM\nEMIT MOD -7 2\nEND PROGRAM") == "1\n", "MOD takes the divisor sign")
    ok(run("PROGRAM\nEMIT DIV 1 0\nEND PROGRAM") == "TRAP div_zero\n", "div_zero")
    ok(run("PROGRAM\nEMIT MOD 1 0\nEND PROGRAM") == "TRAP mod_zero\n", "mod_zero")
    ok(
        run('PROGRAM\nEMIT ADD 1 "a"\nEND PROGRAM') == "TRAP type_mismatch\n",
        "arithmetic on a string traps",
    )
    ok(
        run('PROGRAM\nEMIT EQ 1 "1"\nEND PROGRAM') == "false\n",
        "EQ across types is false, not a trap",
    )
    ok(
        run('PROGRAM\nEMIT LT 1 "1"\nEND PROGRAM') == "TRAP type_mismatch\n",
        "ordering across types traps",
    )
    ok(run('PROGRAM\nEMIT INT "x"\nEND PROGRAM') == "TRAP bad_int\n", "bad_int")
    ok(run("PROGRAM\nREAD $a\nEND PROGRAM") == "TRAP input_exhausted\n", "reading past EOF traps")
    ok(run("PROGRAM\nEMIT NOT 0\nEND PROGRAM") == "true\n", "bools render as true/false")
    ok(run("PROGRAM\nEND PROGRAM") == "", "an empty tape means no trailing newline")

    # §6.3 fuel lives in the step loop
    spin = (
        "PROGRAM WITH profile=complete authority=conformance fuel=50\nLABEL t\nJUMP t\nEND PROGRAM"
    )
    ok(run(spin) == "TRAP fuel_exhausted\n", "fuel exhaustion traps")

    # §12 INCLUDE: fail-closed on every edge, and judged alone before it may join
    include_root = tempfile.TemporaryDirectory(prefix="alcorlang-inc-")
    inc_dir = include_root.name

    def _w(name: str, text: str) -> None:
        Path(inc_dir, name).write_text(text, encoding="utf-8")

    _w("lib.alcor", "PROGRAM Double\nRETURN MUL $x 2\nEND PROGRAM\n")
    host = 'PROGRAM\nCALL Double WITH $x=21 INTO $y\nEMIT $y\nEND PROGRAM\nINCLUDE "lib.alcor"\n'
    ok(run(host, base_dir=inc_dir) == "42\n", "an included block is CALLable")
    try:
        run(host)
        ok(False, "INCLUDE with no base_dir must refuse")
    except AlcorLangError as exc:
        ok("no include root" in str(exc), "no base_dir -> refused, and it says why")
    for bad in ("../lib.alcor", "/etc/passwd", "a/b.alcor", "Lib.alcor", "lib.txt"):
        try:
            run(f'PROGRAM\nEND PROGRAM\nINCLUDE "{bad}"\n', base_dir=inc_dir)
            ok(False, f"bad include name {bad!r} must refuse")
        except AlcorLangError:
            ok(True, f"bad include name {bad!r} refused")
    try:
        run('PROGRAM\nEND PROGRAM\nINCLUDE "ghost.alcor"\n', base_dir=inc_dir)
        ok(False, "a missing library must refuse")
    except AlcorLangError as exc:
        ok("no such library" in str(exc), "a missing library is refused by name")
    _w("a.alcor", 'PROGRAM Aa\nRETURN 1\nEND PROGRAM\nINCLUDE "b.alcor"\n')
    _w("b.alcor", 'PROGRAM Bb\nRETURN 2\nEND PROGRAM\nINCLUDE "a.alcor"\n')
    try:
        run('PROGRAM\nEND PROGRAM\nINCLUDE "a.alcor"\n', base_dir=inc_dir)
        ok(False, "an include cycle must refuse")
    except AlcorLangError as exc:
        ok("cycle" in str(exc), "an include cycle is refused")
    _w("hot.alcor", "PROGRAM Hot WITH profile=complete\nRETURN 1\nEND PROGRAM\n")
    try:
        run('PROGRAM\nEND PROGRAM\nINCLUDE "hot.alcor"\n', base_dir=inc_dir)
        ok(False, "a library must not carry props")
    except AlcorLangError as exc:
        ok(
            "declares no props" in str(exc),
            "a library block with profile= is refused: an include can never escalate",
        )
    _w("loopy.alcor", "PROGRAM Loopy\nLABEL t\nJUMP t\nEND PROGRAM\n")
    try:
        run('PROGRAM\nEND PROGRAM\nINCLUDE "loopy.alcor"\n', base_dir=inc_dir)
        ok(False, "a looping library must refuse")
    except AlcorLangError:
        ok(True, "a library is judged as default-profile alone: backward JUMP refused")
    _w("anon.alcor", "PROGRAM\nRETURN 1\nEND PROGRAM\n")
    try:
        run('PROGRAM\nEND PROGRAM\nINCLUDE "anon.alcor"\n', base_dir=inc_dir)
        ok(False, "an unnamed library block must refuse")
    except AlcorLangError as exc:
        ok("must be named" in str(exc), "an unnamed library block is refused")
    ok(
        run('PROGRAM\nEMIT "INCLUDE is five letters then CLUDE"\nEND PROGRAM').startswith(
            "INCLUDE is"
        ),
        "the word INCLUDE inside a string is just a string",
    )
    include_root.cleanup()

    # run_metered: the same bound, but readable before you hit it
    m = run_metered(spin)
    ok(m["exhausted"] and m["trap"] == "fuel_exhausted", "metered run reports the trap")
    ok(m["steps"] > m["fuel"], "it stopped because it ran past the ceiling")
    ok(m["headroom"] == 0, "an exhausted program has no headroom left")
    cheap = run_metered("PROGRAM\nEMIT 1\nEND PROGRAM")
    ok(
        cheap["trap"] is None and cheap["tape"] == "1\n",
        "a cheap program returns the same tape run() would",
    )
    ok(
        cheap["steps"] > 0 and cheap["headroom"] > 0,
        "a program that finished still reports what it spent",
    )
    ok(
        run_metered(spin, fuel=5)["steps"] < m["steps"],
        "the caller's ceiling overrides the program's own declaration",
    )
    try:
        run_metered(spin, fuel=0)
        ok(False, "fuel=0 override is refused")
    except AlcorLangError:
        ok(True, "fuel=0 override is refused: unbounded is not something a caller grants")

    # §8.4 interpolation is inert data and never re-tokenized
    ok(
        run('PROGRAM\nLET $m "EMIT 99"\nEMIT $m\nEND PROGRAM') == "EMIT 99\n",
        "a cell holding source text is data, not code",
    )

    # the three backends must agree
    core = compile_core("PROGRAM\nLET $x ADD MUL 2 3 4\nEMIT $x\nEND PROGRAM")
    ok(
        [i[0] for i in core.entry.code][-1] == "RET",
        "every block ends in RET (falling off the end returns 0)",
    )
    ok("int main" in lower_c("PROGRAM\nEMIT 1\nEND PROGRAM"), "C has a main")
    ok(
        "alcor_gate_effect" not in lower_c("PROGRAM\nEMIT 1\nEND PROGRAM"),
        "an effect-free binary does not reference the gate shim",
    )
    effect_c = lower_c('PROGRAM\nWRITE Message "t" TO File o.txt\nEND PROGRAM')
    ok(
        "alcor_gate_effect_v1" in effect_c
        and 'alc_trap("effect_host_unavailable")' in effect_c
        and "alcor_gate_effect_v1(" not in effect_c.split("int main", 1)[-1],
        "effectful C reserves the byte ABI but traps closed (§6.4)",
    )
    # §8.4 "no eval, ever" is a property of the EMITTED code, so check the
    # emitted code. re.compile is not code compilation and is exempted by name.
    emitted = lower_python('PROGRAM\nLET $m "1+1"\nEMIT $m\nEND PROGRAM').replace(
        "_re.compile(", ""
    )
    ok(
        not any(bad in emitted for bad in ("eval(", "exec(", "compile(")),
        "the lowered Python contains no eval/exec/compile (§8.4)",
    )

    # the vocabulary, and whether it is the real table
    info = table()
    ok(info["element_count"] > 0, "a vocabulary is loaded")
    if info["is_fallback"]:
        print(
            "selftest NOTE: no vocabulary table could be loaded; using the corpus-derived "
            f"fallback vocabulary {info['elements']}"
        )

    corpus_report = _corpus_sweep()
    if corpus_report:
        passed, total = corpus_report["passed"], corpus_report["total"]
        names = ", ".join(corpus_report["failures"]) or "-"
        ok(
            corpus_report["failed"] == 0,
            f"conformance corpus in-process: {passed}/{total} ({names})",
        )
        print(f"selftest: corpus sweep {passed}/{total} (parse+run kinds only; the referee judges)")

    print(f"selftest: {checks - len(failed)}/{checks}")
    for msg in failed:
        print("  FAIL:", msg)
    return 1 if failed else 0


def _corpus_sweep() -> dict[str, Any] | None:
    """Run the parse and run halves of the corpus in-process.

    The referee is still the judge (it runs each test in its own process and working
    directory); this is the fast inner loop.  Returns ``None`` when the corpus file is absent.
    """
    if not CORPUS_PATH.is_file():
        return None
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    passed, failures, total = 0, [], 0
    for test in corpus.get("tests", []):
        if test.get("kind") not in ("parse", "run"):
            continue
        total += 1
        try:
            if test["kind"] == "parse":
                got = parse(test["src"])
                good = not test.get("expect_error") and json.dumps(
                    got, sort_keys=True
                ) == json.dumps(test.get("expect"), sort_keys=True)
            else:
                got = run(test["src"], test.get("input", ""))
                good = not test.get("expect_error") and got == test.get("expect", "")
        except Exception:  # noqa: BLE001
            good = bool(test.get("expect_error"))
        if good:
            passed += 1
        else:
            failures.append(test["id"])
    return {"passed": passed, "total": total, "failed": total - passed, "failures": failures}
