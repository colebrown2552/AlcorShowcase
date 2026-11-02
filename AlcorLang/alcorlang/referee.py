"""The conformance referee: a neutral, fail-closed judge for any AlcorLang implementation.

It judges an implementation under test against the conformance corpus
(``conformance/conformance_v2.json``).  The referee is deliberately boring and strict: if
anything is missing, broken, hanging or ambiguous, the verdict is FAIL.  It must be able to say
no, and ``--selftest`` proves that it can by failing a deliberately broken stub on every axis.

Usage::

    python -m alcorlang.referee --impl DIR [--milestone M1|M2|M3|M4] [--json]
                                [--tests FILE] [--timeout SECS]
    python -m alcorlang.referee --selftest

Contract with the implementation under test: ``DIR`` must contain an importable ``alcorlang``
(a package or a single ``alcorlang.py``) exposing

    parse(src) -> ast_dict                      (M1+)  JSON-serializable dict
    run(src, input_text='') -> output_text      (M2+)  returns str, never prints
    lower_python(src) -> python_source          (M3+)  returns str
    lower_c(src) -> c_source                    (M4)   returns str

Each test runs in a throwaway child interpreter (crash and hang isolation: a segfaulting or
hanging implementation cannot take the referee down and is failed on timeout), started in
isolated mode so nothing on the caller's ``sys.path`` leaks in.

Judging rules (fail-closed):

* A missing required function fails that test, and so its milestone.
* A missing or broken implementation fails every test.
* A per-test timeout (default 10 s) is a failure.
* ``parse``: the returned dict is compared as canonical JSON, exactly.
* ``run``: the returned string is compared exactly (no stripping, no normalizing).
* ``lower_python``: the lowered source is executed in a fresh ``python -I`` subprocess with a
  timeout, and its stdout is compared exactly.
* ``lower_c``: a static check only, so no C toolchain is needed: non-empty source containing
  every ``expect_contains`` substring (default ``int main``).
* ``gate``: the implementation runs in a fresh working directory and must leave a receipt
  artifact there (a glob) instead of performing any effect.  No receipt is a failure.
* Nothing is ever executed with ``shell=True``.
* Exit 0 only when every selected test passes and at least one ran; 1 on any failure; 2 on an
  environment or usage error.

Milestones are cumulative: ``--milestone M3`` runs M1, M2 and M3 tests.

Corpus schema::

    {"version": 2, "tests": [{
        "id": "m2-run-echo",              unique
        "milestone": "M1"|"M2"|"M3"|"M4",
        "kind": "parse"|"run"|"gate"|"lower_python"|"lower_c",
        "src": "<AlcorLang source>",
        "input": "",                      optional text for READ
        "expect": {...} | "...",          AST dict (parse) or exact output
        "expect_error": false,            optional: an exception is the expected result
        "expect_contains": ["int main"],  lower_c only
        "receipt": "receipts/*.json"      gate only (glob)
    }]}

Stdlib only, and portable: pathlib, no fork, no ANSI.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import io
import json
import os
import subprocess
import sys
import tempfile
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

MILESTONES = ["M1", "M2", "M3", "M4"]
KIND_FUNC = {
    "parse": "parse",
    "run": "run",
    "gate": "run",
    "lower_python": "lower_python",
    "lower_c": "lower_c",
}
DEFAULT_TESTS = Path(__file__).resolve().parents[1] / "conformance" / "conformance_v2.json"
DEFAULT_TIMEOUT = 10.0
DEFAULT_RECEIPT_GLOB = "receipts/*"


def canon(obj: Any) -> str:
    """Return canonical JSON text, for exact structural comparison."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def _has_implementation(impl_dir: Path) -> bool:
    """Return whether ``impl_dir`` holds an ``alcorlang`` package or module to judge."""
    package_init = impl_dir / "alcorlang" / "__init__.py"
    return (impl_dir / "alcorlang.py").is_file() or package_init.is_file()


# ----------------------------------------------------------------------------
# Child mode: executes exactly ONE test against the impl, prints result JSON.
# Runs in its own interpreter so hangs/crashes in the impl are contained.
# ----------------------------------------------------------------------------


def _child_main() -> int:
    payload = json.loads(sys.stdin.read())
    impl_dir = Path(payload["impl_dir"])
    test = payload["test"]
    workdir = Path(payload["workdir"])
    timeout = float(payload["timeout"])

    def out(status: str, reason: str = "") -> int:
        print(json.dumps({"status": status, "reason": reason}))
        return 0

    if not _has_implementation(impl_dir):
        return out("fail", "no alcorlang package or module in the implementation dir (fail-closed)")

    # The import is shielded so stray prints cannot corrupt the referee protocol.  The child
    # runs in isolated mode, so putting the implementation dir first on sys.path guarantees the
    # module judged is the one that was asked for.
    shield = io.StringIO()
    try:
        with contextlib.redirect_stdout(shield):
            sys.path.insert(0, str(impl_dir))
            mod = importlib.import_module("alcorlang")
    except BaseException:
        return out(
            "fail",
            f"import error (fail-closed): {traceback.format_exc(limit=1).strip().splitlines()[-1]}",
        )

    kind = test["kind"]
    func_name = KIND_FUNC[kind]
    func = getattr(mod, func_name, None)
    if not callable(func):
        return out("fail", f"missing function {func_name}() (fail-closed)")

    src = test.get("src", "")
    input_text = test.get("input", "")
    expect_error = bool(test.get("expect_error", False))

    def call(fn: Callable[..., Any], *args: Any) -> Any:
        with contextlib.redirect_stdout(shield):
            return fn(*args)

    try:
        if kind == "parse":
            try:
                got = call(func, src)
            except Exception as exc:
                if expect_error:
                    return out("pass", f"raised {type(exc).__name__} as expected")
                return out("fail", f"parse raised {type(exc).__name__}: {exc}")
            if expect_error:
                return out("fail", "expected an error but parse succeeded")
            if not isinstance(got, dict):
                return out("fail", f"parse returned {type(got).__name__}, expected dict")
            try:
                got_c = canon(got)
            except (TypeError, ValueError):
                return out("fail", "parse result is not JSON-serializable (fail-closed)")
            exp_c = canon(test.get("expect"))
            if got_c != exp_c:
                return out("fail", f"AST mismatch: expected {exp_c} got {got_c}")
            return out("pass")

        if kind == "run":
            try:
                got = call(func, src, input_text)
            except Exception as exc:
                if expect_error:
                    return out("pass", f"raised {type(exc).__name__} as expected")
                return out("fail", f"run raised {type(exc).__name__}: {exc}")
            if expect_error:
                return out("fail", "expected an error but run succeeded")
            if not isinstance(got, str):
                return out("fail", f"run returned {type(got).__name__}, expected str")
            exp = test.get("expect", "")
            if got != exp:
                return out("fail", f"output mismatch: expected {exp!r} got {got!r}")
            return out("pass")

        if kind == "gate":
            # Gate-preservation: the impl runs inside a fresh workdir and must
            # leave a RECEIPT ARTIFACT there instead of performing any effect.
            old_cwd = Path.cwd()
            try:
                os.chdir(str(workdir))
                try:
                    got = call(func, src, input_text)
                except Exception as exc:
                    return out("fail", f"gate run raised {type(exc).__name__}: {exc}")
            finally:
                os.chdir(str(old_cwd))
            pattern = test.get("receipt", DEFAULT_RECEIPT_GLOB)
            matches = sorted(str(p.relative_to(workdir)) for p in workdir.glob(pattern))
            if not matches:
                return out("fail", f"no receipt artifact matching {pattern!r} (fail-closed)")
            if "expect" in test and isinstance(got, str) and got != test["expect"]:
                return out(
                    "fail",
                    f"receipt ok but output mismatch: expected {test['expect']!r} got {got!r}",
                )
            return out("pass", f"receipt: {', '.join(matches)}")

        if kind == "lower_python":
            try:
                lowered = call(func, src)
            except Exception as exc:
                if expect_error:
                    return out("pass", f"raised {type(exc).__name__} as expected")
                return out("fail", f"lower_python raised {type(exc).__name__}: {exc}")
            if not isinstance(lowered, str) or not lowered.strip():
                return out("fail", "lower_python returned empty/non-str source (fail-closed)")
            lowered_file = workdir / "lowered.py"
            lowered_file.write_text(lowered, encoding="utf-8")
            try:
                proc = subprocess.run(
                    [sys.executable, "-I", str(lowered_file)],
                    input=input_text,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=timeout,
                    cwd=str(workdir),
                )  # never shell=True
            except subprocess.TimeoutExpired:
                return out("fail", "lowered python timed out (fail-closed)")
            if expect_error:
                if proc.returncode != 0:
                    return out("pass", f"lowered python exited {proc.returncode} as expected")
                return out("fail", "expected an error but lowered python exited 0")
            if proc.returncode != 0:
                return out(
                    "fail",
                    f"lowered python exited {proc.returncode}: {proc.stderr.strip()[-200:]}",
                )
            exp = test.get("expect", "")
            if proc.stdout != exp:
                return out(
                    "fail",
                    f"lowered-python output mismatch: expected {exp!r} got {proc.stdout!r}",
                )
            return out("pass")

        if kind == "lower_c":
            try:
                lowered = call(func, src)
            except Exception as exc:
                if expect_error:
                    return out("pass", f"raised {type(exc).__name__} as expected")
                return out("fail", f"lower_c raised {type(exc).__name__}: {exc}")
            if not isinstance(lowered, str) or not lowered.strip():
                return out("fail", "lower_c returned empty/non-str source (fail-closed)")
            needles = test.get("expect_contains", ["int main"])
            missing = [n for n in needles if n not in lowered]
            if missing:
                return out("fail", f"C source missing required substrings: {missing}")
            return out("pass", "static check only (no C toolchain)")

        return out("fail", f"unknown test kind {kind!r} (fail-closed)")
    except BaseException:
        last_line = traceback.format_exc(limit=1).strip().splitlines()[-1]
        return out("fail", f"referee child error (fail-closed): {last_line}")


# ----------------------------------------------------------------------------
# Parent mode: select tests, run each in a child subprocess, judge, report.
# ----------------------------------------------------------------------------


def select_tests(corpus: dict[str, Any], milestone: str) -> list[dict[str, Any]]:
    """Pick the corpus tests up to and including ``milestone`` (milestones are cumulative).

    Raises:
        SystemExit: If the milestone, or any test's milestone, is not M1 to M4.
    """
    rank = {m: i for i, m in enumerate(MILESTONES)}
    if milestone not in rank:
        raise SystemExit(f"referee: unknown milestone {milestone!r}")
    picked = []
    for t in corpus.get("tests", []):
        m = t.get("milestone")
        if m not in rank:
            raise SystemExit(f"referee: test {t.get('id')!r} has invalid milestone {m!r}")
        if rank[m] <= rank[milestone]:
            picked.append(t)
    return picked


def run_one_test(
    impl_dir: Path, test: dict[str, Any], timeout: float, scratch_root: Path
) -> dict[str, str]:
    """Judge one test in a child interpreter and return its verdict.

    Returns:
        ``{"status": "pass" | "fail", "reason": ...}``.  Any timeout, crash or malformed
        verdict from the child is a failure.
    """
    workdir = Path(tempfile.mkdtemp(prefix=f"t-{test.get('id', 'x')[:40]}-", dir=str(scratch_root)))
    payload = json.dumps(
        {
            "impl_dir": str(impl_dir),
            "test": test,
            "workdir": str(workdir),
            "timeout": timeout,
        }
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-I", str(Path(__file__).resolve()), "--_child"],
            input=payload,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )  # never shell=True
    except subprocess.TimeoutExpired:
        return {"status": "fail", "reason": f"timeout after {timeout:.0f}s (fail-closed)"}
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if not lines:
        return {
            "status": "fail",
            "reason": (
                f"child produced no verdict (rc={proc.returncode}) "
                f"{proc.stderr.strip()[-200:]} (fail-closed)"
            ),
        }
    try:
        result = json.loads(lines[-1])
        if result.get("status") not in ("pass", "fail"):
            raise ValueError
        return result
    except (ValueError, TypeError):
        return {"status": "fail", "reason": "unparseable child verdict (fail-closed)"}


def run_conformance(
    impl_dir: Path, milestone: str, tests: list[dict[str, Any]], timeout: float
) -> dict[str, Any]:
    """Judge an implementation against the selected tests.

    Args:
        impl_dir: A directory containing an importable ``alcorlang``.
        milestone: The milestone label, recorded in the report.
        tests: The tests from ``select_tests``.
        timeout: Seconds allowed per test.

    Returns:
        A report: totals, ``all_pass`` and one result per test.
    """
    scratch_root = Path(tempfile.mkdtemp(prefix="alcorlang-referee-"))
    results = []
    for t in tests:
        if not _has_implementation(impl_dir):
            res = {"status": "fail", "reason": "no alcorlang package or module found (fail-closed)"}
        else:
            res = run_one_test(impl_dir, t, timeout, scratch_root)
        results.append(
            {
                "id": t.get("id", "?"),
                "milestone": t.get("milestone", "?"),
                "kind": t.get("kind", "?"),
                "status": res["status"],
                "reason": res.get("reason", ""),
            }
        )
    passed = sum(1 for r in results if r["status"] == "pass")
    return {
        "impl": str(impl_dir),
        "milestone": milestone,
        "total": len(results),
        "passed": passed,
        "all_pass": len(results) > 0 and passed == len(results),
        "results": results,
    }


def print_report(report: dict[str, Any]) -> None:
    """Print a report as a table with one row per test and a closing pass count."""
    id_width = max([len(r["id"]) for r in report["results"]] + [4])
    kind_width = max([len(r["kind"]) for r in report["results"]] + [4])
    header = f"{'TEST':<{id_width}}  {'MS':<3} {'KIND':<{kind_width}}  {'RESULT':<6}  DETAIL"
    print(header)
    print("-" * len(header))
    for r in report["results"]:
        mark = "PASS" if r["status"] == "pass" else "FAIL"
        print(
            f"{r['id']:<{id_width}}  {r['milestone']:<3} {r['kind']:<{kind_width}}  "
            f"{mark:<6}  {r['reason']}"
        )
    print(f"MILESTONE {report['milestone']}: {report['passed']}/{report['total']}")


# ----------------------------------------------------------------------------
# Selftest: prove the referee can say no.
# ----------------------------------------------------------------------------

SELFTEST_CORPUS = {
    "version": 2,
    "tests": [
        {
            "id": "st-m1-parse-emit",
            "milestone": "M1",
            "kind": "parse",
            "src": "EMIT hi",
            "expect": {"type": "program", "body": [{"type": "emit", "value": "hi"}]},
        },
        {
            "id": "st-m2-run-emit",
            "milestone": "M2",
            "kind": "run",
            "src": "EMIT hi",
            "expect": "hi\n",
        },
        {
            "id": "st-m2-run-echo",
            "milestone": "M2",
            "kind": "run",
            "src": "ECHO",
            "input": "abc",
            "expect": "abc\n",
        },
        {"id": "st-m2-run-sleep", "milestone": "M2", "kind": "run", "src": "SLEEP", "expect": ""},
        {
            "id": "st-m2-gate-mail",
            "milestone": "M2",
            "kind": "gate",
            "src": "GATE mail.send",
            "receipt": "receipts/*.json",
        },
        {
            "id": "st-m3-lower-python",
            "milestone": "M3",
            "kind": "lower_python",
            "src": "EMIT hi",
            "expect": "hi\n",
        },
        {
            "id": "st-m4-lower-c",
            "milestone": "M4",
            "kind": "lower_c",
            "src": "EMIT hi",
            "expect_contains": ["int main"],
        },
    ],
}

GOOD_STUB = '''\
"""Selftest GOOD stub: implements exactly the selftest corpus behaviors."""
import json
from pathlib import Path

def parse(src):
    if src.startswith("EMIT "):
        return {"type": "program",
                "body": [{"type": "emit", "value": src[5:]}]}
    return {"type": "program", "body": []}

def run(src, input_text=""):
    if src.startswith("EMIT "):
        return src[5:] + "\\n"
    if src == "ECHO":
        return input_text + "\\n"
    if src == "SLEEP":
        return ""
    if src.startswith("GATE "):
        d = Path("receipts"); d.mkdir(parents=True, exist_ok=True)
        (d / "receipt.json").write_text(
            json.dumps({"gated_effect": src[5:], "performed": False}),
            encoding="utf-8")
        return ""
    return ""

def lower_python(src):
    if src.startswith("EMIT "):
        return "print(%r)\\n" % src[5:]
    return "pass\\n"

def lower_c(src):
    return ("#include <stdio.h>\\n"
            "int main(void) { printf(%s); return 0; }\\n"
            % json.dumps(src[5:] + "\\n"))
'''

BROKEN_STUB = '''\
"""Selftest BROKEN stub: wrong on every axis. The referee must FAIL all of it."""
import time
from pathlib import Path

def parse(src):
    return {"type": "oops"}                      # wrong AST

def run(src, input_text=""):
    if src == "ECHO":
        raise RuntimeError("echo exploded")      # unexpected exception
    if src == "SLEEP":
        time.sleep(60)                           # must be killed by timeout
        return ""
    if src.startswith("GATE "):
        Path("real_effect.txt").write_text("effect performed, no receipt")
        return ""                                # real effect, NO receipt
    return "WRONG OUTPUT"

def lower_python(src):
    return "print('WRONG')\\n"                   # wrong lowered behavior

# lower_c intentionally missing -> missing-function must FAIL M4
'''


def selftest(timeout: float) -> int:
    """Prove the referee can say no, and return a process exit status.

    A known-good stub must pass every test, a stub that is wrong on every axis (wrong AST,
    exception, hang, effect with no receipt, wrong lowering, missing function) must fail every
    test, and milestone gating must select only the requested tests.
    """
    root = Path(tempfile.mkdtemp(prefix="alcorlang-referee-selftest-"))
    good = root / "good_impl"
    broken = root / "broken_impl"
    good.mkdir()
    broken.mkdir()
    (good / "alcorlang.py").write_text(GOOD_STUB, encoding="utf-8")
    (broken / "alcorlang.py").write_text(BROKEN_STUB, encoding="utf-8")
    tests = select_tests(SELFTEST_CORPUS, "M4")

    print("=== selftest 1/3: GOOD stub must fully PASS ===")
    good_report = run_conformance(good, "M4", tests, timeout)
    print_report(good_report)
    print()
    print("=== selftest 2/3: BROKEN stub must fully FAIL ===")
    broken_report = run_conformance(broken, "M4", tests, timeout)
    print_report(broken_report)
    print()
    print("=== selftest 3/3: milestone gating (M1 selects only M1 tests) ===")
    m1_tests = select_tests(SELFTEST_CORPUS, "M1")

    failures = []
    if not good_report["all_pass"]:
        failures.append(
            f"good stub did not fully pass ({good_report['passed']}/{good_report['total']})"
        )
    if broken_report["passed"] != 0:
        failures.append(
            f"broken stub passed {broken_report['passed']} tests; referee failed to say no"
        )
    reasons = " | ".join(r["reason"] for r in broken_report["results"])
    if "timeout" not in reasons:
        failures.append("timeout was not detected as a failure")
    if "missing function" not in reasons:
        failures.append("missing function was not detected as a failure")
    if "receipt" not in reasons:
        failures.append("missing gate receipt was not detected as a failure")
    selected = [t["id"] for t in m1_tests]
    if selected != ["st-m1-parse-emit"]:
        failures.append(f"milestone gating selected wrong tests: {selected}")
    else:
        print(f"M1 selection: {selected}  -> ok")
    print()
    if failures:
        for f in failures:
            print(f"SELFTEST FAILURE: {f}")
        print("SELFTEST: FAIL")
        return 1
    failed = broken_report["total"] - broken_report["passed"]
    print(
        f"SELFTEST: PASS (referee proven able to say no: {failed}/{broken_report['total']} broken "
        "tests correctly FAILED, incl. timeout, missing function, missing receipt)"
    )
    return 0


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """Run the referee from the command line and return the exit status (0, 1 or 2)."""
    ap = argparse.ArgumentParser(
        prog="python -m alcorlang.referee",
        description="AlcorLang v2 conformance referee (fail-closed).",
    )
    ap.add_argument("--impl", help="directory containing the alcorlang package or module to judge")
    ap.add_argument(
        "--milestone",
        choices=MILESTONES,
        default="M4",
        help="milestone to judge (cumulative; default M4 = all)",
    )
    ap.add_argument(
        "--tests", default=str(DEFAULT_TESTS), help="conformance corpus JSON (default: %(default)s)"
    )
    ap.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help="seconds per test (default: %(default)s)",
    )
    ap.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="emit machine-readable JSON instead of a table",
    )
    ap.add_argument(
        "--selftest", action="store_true", help="prove the referee can fail a broken implementation"
    )
    ap.add_argument("--_child", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    if args._child:
        return _child_main()
    if args.selftest:
        return selftest(min(args.timeout, 4.0))
    if not args.impl:
        ap.error("--impl is required (or use --selftest)")

    impl_dir = Path(args.impl).resolve()
    if not impl_dir.is_dir():
        print(f"referee: impl dir not found: {impl_dir}", file=sys.stderr)
        return 2
    tests_path = Path(args.tests)
    if not tests_path.is_file():
        print(f"referee: conformance corpus not found: {tests_path} (fail-closed)", file=sys.stderr)
        return 2
    try:
        corpus = json.loads(tests_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        print(f"referee: conformance corpus is not valid JSON: {exc}", file=sys.stderr)
        return 2
    tests = select_tests(corpus, args.milestone)
    if not tests:
        print(
            f"referee: no conformance tests selected for {args.milestone} (fail-closed)",
            file=sys.stderr,
        )
        return 2

    report = run_conformance(impl_dir, args.milestone, tests, args.timeout)
    if args.as_json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)
    return 0 if report["all_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
