"""End-to-end demo of AlcorLang: run it, break it, lint it, lower it, judge it, host it.

Everything runs offline and deterministically on a clean machine.  Each section prints what it
computed and checks it, so the demo is also a test of the shipped interfaces: the real
``python -m alcorlang`` command line is used wherever a user would use it, and the library API
where a program would.  Nothing here is canned; the only optional step is the native C build,
which is skipped (and says so) when no C compiler is installed.

Usage, from anywhere::

    python demo/run_demo.py            # from the alcorlang component folder
    python AlcorLang/demo/run_demo.py  # from the repository root

Add ``--json PATH`` to also write a summary of the run (programs, traces, lint results and
every check) for the viewer in ``AlcorLang/viewer``. A path ending in ``.js`` is written as the
script the viewer loads. Without it nothing else changes.

Exit status is 0 when every check passes.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import alcorlang  # noqa: E402
from alcorlang import native, receipts, selfhost  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROGRAMS = ROOT / "programs"
RESULTS: list[tuple[str, bool]] = []
# What the run did, kept only so ``--json`` can export it. Printing is unaffected.
SECTIONS: list[dict[str, Any]] = []
CONFORMANCE: dict[str, Any] = {}


def section(title: str) -> None:
    SECTIONS.append({"title": re.sub(r"^\d+\. ", "", title), "checks": []})
    print(f"\n== {title} " + "=" * max(3, 70 - len(title)))


def check(label: str, condition: bool) -> None:
    """Record one check and print it."""
    RESULTS.append((label, bool(condition)))
    if SECTIONS:
        SECTIONS[-1]["checks"].append({"label": label, "ok": bool(condition)})
    print(f"  [{'ok' if condition else 'FAIL'}] {label}")


def cli(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    """Run the shipped command line exactly as a user would."""
    return subprocess.run(
        [sys.executable, "-X", "utf8", "-m", "alcorlang", *args],
        cwd=ROOT,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def show(text: str, indent: str = "      ", limit: int = 12) -> None:
    lines = text.rstrip("\n").splitlines()
    for line in lines[:limit]:
        print(indent + textwrap.shorten(line, 100 - len(indent), placeholder="..."))
    if len(lines) > limit:
        print(f"{indent}... ({len(lines) - limit} more lines)")


def corpus_cases(filename: str) -> list[dict[str, Any]]:
    manifest = json.loads((PROGRAMS / "corpus.json").read_text(encoding="utf-8"))
    return [case for case in manifest["programs"] if case["file"] == filename]


# -------------------------------------------------------------------------------------------
def demo_policies() -> None:
    section("1. Policy programs (default profile: every one provably halts)")
    for filename, expected in (
        ("quorum_gate.alcor", "ALLOW REFUSE HOLD REFUSE"),
        ("capped_backoff.alcor", "5 10 20 40 60 60"),
    ):
        done = cli("run", f"programs/{filename}")
        print(f"  {filename:<22} -> {' '.join(done.stdout.split())}")
        check(f"{filename} prints {expected!r}", done.stdout.split() == expected.split())
    for case in corpus_cases("kernel.alcor"):
        done = cli("run", "programs/kernel.alcor", "--input-text", "\n".join(case["input"]))
        keys = ("action", "reason")
        decision = [line for line in done.stdout.splitlines() if line.split("=")[0] in keys]
        scenario = case["name"].split(": ")[1]
        print(f"  kernel.alcor           -> {', '.join(decision)}   ({scenario})")
        check(f"kernel scenario '{scenario}'", done.stdout.splitlines() == case["expected_output"])


def demo_v3() -> None:
    section("2. v3 syntax lowers to the same core")
    source = (PROGRAMS / "backoff_v3.alcor").read_text(encoding="utf-8")
    print("  programs/backoff_v3.alcor (10 lines):")
    show(source, limit=10)
    lowered = cli("transpile", "programs/backoff_v3.alcor").stdout
    print("  lowered to canonical v2 (a constant FOR is unrolled, IF becomes forward jumps):")
    show(lowered, limit=10)
    check("the lowered program has no LOOP and no backward jump", "LOOP" not in lowered)
    for tries, wanted in (("0", "attempt 0: wait 5s"), ("3", "attempt 3: wait 40s")):
        done = cli("run", "programs/backoff_v3.alcor", "--input-text", tries)
        print(f"  input {tries!r} -> {done.stdout.strip()}")
        check(f"backoff_v3 with input {tries} prints {wanted!r}", done.stdout.strip() == wanted)
    check(
        "the top-level API runs a v3 source directly",
        alcorlang.run(source, "3") == "attempt 3: wait 40s\n",
    )


def demo_halting() -> None:
    section("3. Halting is decided before the program runs")
    loop = "PROGRAM\nLABEL top\nEMIT 1\nJUMP top\nEND PROGRAM\n"
    done = cli("check", "-", stdin=loop)
    print("  default profile, backward JUMP:")
    show(done.stderr.strip(), limit=2)
    check("a default-profile loop is rejected at compile time", done.returncode == 1)
    unsigned = "PROGRAM WITH profile=complete\nEMIT 1\nEND PROGRAM\n"
    print(f"  complete profile, no authority  -> {alcorlang.run(unsigned).strip()}")
    check(
        "complete without authority parses but run() refuses",
        alcorlang.run(unsigned) == "REFUSED unsigned_complete\n",
    )
    runaway = (PROGRAMS / "runaway.alcor").read_text(encoding="utf-8")
    report = alcorlang.run_metered(runaway)
    print(
        f"  runaway.alcor (fuel 1200)       -> TRAP {report['trap']} after {report['steps']} steps"
    )
    check("an unbounded loop is stopped by fuel", report["exhausted"] and report["steps"] == 1201)
    sandboxed = unsigned.replace("profile=complete", "profile=complete authority=conformance")
    squeezed = alcorlang.run_metered(sandboxed, fuel=1)
    after = alcorlang.run(sandboxed)
    print(f"  a metered fuel override of 1 trapped, and the next plain run gives {after.strip()!r}")
    check("a fuel override stays local to its call", squeezed["exhausted"] and after == "1\n")


def demo_lint() -> None:
    section("4. Lint: stable rule ids")
    broken = "PROGRAM\nEMIT 1\nLABEL top\nEMIT 2\nJUMP top\nEND PROGRAM\n"
    done = cli("lint", "-", stdin=broken)
    show(done.stdout, limit=4)
    check(
        "a parse failure carries the rule id parse/error and exits 1",
        "error parse/error" in done.stdout and done.returncode == 1,
    )
    done = cli("lint", "programs/runaway.alcor")
    show(done.stdout, limit=3)
    strict = cli("lint", "programs/runaway.alcor", "--strict")
    check(
        "warning profile/conformance-authority is advisory (exit 0) ...",
        "profile/conformance-authority" in done.stdout and done.returncode == 0,
    )
    check("... and fails with --strict (exit 1)", strict.returncode == 1)
    audit = json.loads(cli("audit", "programs", "--format", "json").stdout)
    print(f"  audit programs: {audit['files_scanned']} files, {audit['summary']}")
    check("the shipped examples have no lint errors", audit["summary"]["error"] == 0)


def demo_lowering() -> None:
    section("5. Lowering: one program, three backends, identical output")
    with tempfile.TemporaryDirectory(prefix="alcorlang-demo-") as tmp:
        for filename in ("quorum_gate.alcor", "capped_backoff.alcor"):
            reference = cli("run", f"programs/{filename}").stdout
            lowered = cli("lower", f"programs/{filename}", "--target", "python").stdout
            script = Path(tmp, filename + ".py")
            script.write_text(lowered, encoding="utf-8", newline="\n")
            ran = subprocess.run(
                [sys.executable, "-I", str(script)],
                capture_output=True,
                text=True,
                check=False,
                cwd=tmp,
            )
            print(
                f"  {filename:<22} interpreter: {len(reference.splitlines())} lines; "
                f"lowered Python: {len(lowered.splitlines())} lines"
            )
            check(
                f"{filename}: the lowered script (python -I) matches the interpreter",
                ran.stdout == reference,
            )
        source = (PROGRAMS / "capped_backoff.alcor").read_text(encoding="utf-8")
        check(
            "C lowering produces a translation unit with main()",
            "int main" in alcorlang.lower_c(source),
        )
        try:
            built = native.build_native(source, str(PROGRAMS), Path(tmp, "cache"))
        except native.AlcorCompilerError as exc:
            print(f"  C backend: native build skipped ({textwrap.shorten(str(exc), 60)})")
        else:
            out, _err, code = native.run_native(built, b"")
            print(f"  capped_backoff.alcor   built with the local C compiler and run, exit {code}")
            expected = alcorlang.run(source)
            check(
                "the native binary matches the interpreter",
                out.decode().replace("\r\n", "\n") == expected,
            )
        refused = cli("native", "run", "programs/runaway.alcor", "--cache-dir", str(Path(tmp, "c")))
        check(
            "a native build refuses a complete-profile program",
            refused.returncode == 1 and "refused" in refused.stderr,
        )


def demo_gate() -> None:
    section("6. Effects never run inside the language")
    source = (
        'PROGRAM\nEMIT "before"\nWRITE Message "deploy" TO File out.txt\nEMIT "after"\n'
        "END PROGRAM\n"
    )
    with tempfile.TemporaryDirectory(prefix="alcorlang-demo-") as tmp:
        previous = os.getcwd()
        os.chdir(tmp)
        try:
            tape = alcorlang.run(source)
            receipt = json.loads(Path("receipts", "effect_0.json").read_text(encoding="utf-8"))
            wrote_file = Path("out.txt").exists()
        finally:
            os.chdir(previous)
    print(f"  tape: {tape.split()}   (the WRITE produced no output line)")
    print(
        f"  receipt: outcome={receipt['outcome']} reason={receipt['reason_code']} "
        f"attempted={receipt['attempted']}"
    )
    check("the program ran to the end", tape == "before\nafter\n")
    check(
        "the effect left a refusal receipt, not a file",
        wrote_file is False and receipt["outcome"] == "refused",
    )
    body = {k: v for k, v in receipt.items() if k != "receipt_sha256"}
    check(
        "the receipt hashes its own contents",
        receipts.sha256_hex(receipts.canonical_json_bytes(body)) == receipt["receipt_sha256"],
    )


class _StoreThatLosesTheTerminalWrite(alcorlang.InMemoryLifecycle):
    """A store that dies after ATTEMPTED is durable but before the result is written."""

    def finish(self, result_raw: bytes, binding: dict[str, Any]) -> None:
        raise OSError("the store went away before the terminal write")


def demo_hosted() -> None:
    section("7. Hosted run: verified authority, replay and UNKNOWN")
    source = (
        'PROGRAM Notify\nEMIT "start"\nWRITE Message "tick" TO File out.txt\nEMIT "done"\n'
        "END PROGRAM\n"
    )
    revision = "a" * 64
    gate_calls: list[str] = []

    def gate(request_bytes: bytes) -> bytes:
        request = json.loads(request_bytes)
        gate_calls.append(request["request_id"])
        result = alcorlang.effect_result(
            request,
            "complete",
            "applied",
            effect_started=True,
            effect_committed=True,
            postcondition_verified=True,
        )
        return alcorlang.effect_result_bytes(result, request)

    def dying_gate(request_bytes: bytes) -> bytes:
        gate_calls.append("died")
        raise RuntimeError("the effect host died mid-call")

    def verifier(challenge: dict[str, Any], capsule: bytes) -> dict[str, Any]:
        until = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)
        return {
            "schema": "alcor.runtime.authority.decision.v1",
            "granted": True,
            "authority": "operator_gated",
            "challenge_sha256": receipts.sha256_hex(receipts.canonical_json_bytes(challenge)),
            "capsule_sha256": receipts.sha256_hex(capsule),
            "scope_sha256": challenge["effect_scope_sha256"],
            "verifier_id": "demo-verifier",
            "valid_until_utc": until.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    def hosted(
        key: str, store: alcorlang.EffectLifecycle, gate_fn: Any = gate, *, authorised: bool = True
    ) -> dict[str, Any]:
        context = alcorlang.ExecutionContext.hosted(
            "demo-run",
            key,
            revision,
            revision,
            max_fuel=10_000,
            timeout_ms=5_000,
            max_output_bytes=4_096,
            authority_capsule=b"demo-capsule" if authorised else None,
            authority_verifier=verifier if authorised else None,
            lifecycle=store,
            gate_adapter=gate_fn,
        )
        return alcorlang.run_hosted(source, "", None, context)

    store = alcorlang.InMemoryLifecycle()
    first = hosted("deploy-1", store)
    outcomes = [e["outcome"] for e in first["effects"]]
    calls = len(gate_calls)
    print(f"  first run       state={first['state']:<9} gate calls so far={calls}  {outcomes}")
    again = hosted("deploy-1", store)
    replays = len(again["effect_replays"])
    calls = len(gate_calls)
    print(
        f"  same key again  state={again['state']:<9} gate calls so far={calls}  replays={replays}"
    )
    check("an authorised effect completes through the gate", first["state"] == "complete")
    check(
        "the same idempotency key replays the stored receipt and does not call the gate again",
        again["state"] == "complete" and len(gate_calls) == 1 and replays == 1,
    )
    before = len(gate_calls)
    refused = hosted("deploy-2", store, authorised=False)
    print(f"  no verifier     state={refused['state']:<9} reason={refused['reason_code']}")
    check(
        "without verified authority nothing runs and the gate is never called",
        refused["state"] == "refused" and len(gate_calls) == before,
    )
    crashed = hosted("deploy-3", store, dying_gate)
    print(f"  gate dies       state={crashed['state']:<9} reason={crashed['reason_code']}")
    check("a gate that dies mid-call yields UNKNOWN, not success", crashed["state"] == "unknown")

    lossy = _StoreThatLosesTheTerminalWrite()
    lost = hosted("deploy-4", lossy)
    calls = len(gate_calls)
    print(f"  store loses the terminal write: state={lost['state']} reason={lost['reason_code']}")
    retry = hosted("deploy-4", lossy)
    print(f"  retry same key  state={retry['state']:<9} reason={retry['reason_code']}")
    check(
        "the effect may have happened, so ATTEMPTED is never replayed: the retry is UNKNOWN",
        retry["state"] == "unknown" and retry["reason_code"] == "existing_attempted_no_replay",
    )
    check("... and the retry calls the gate zero times", len(gate_calls) == calls)


def demo_conformance() -> None:
    section("8. Conformance: the corpus is the ground truth")
    done = cli("conformance")
    last = done.stdout.strip().splitlines()[-1]
    CONFORMANCE["referee"] = last
    print(f"  referee (each test in its own interpreter): {last}")
    check(
        "the referee passes every conformance test",
        done.returncode == 0 and last.endswith("31/31"),
    )
    done = cli("selftest")
    last = done.stdout.strip().splitlines()[-1]
    passed, total = last.split(": ")[1].split("/")
    CONFORMANCE["selftest"] = {"passed": int(passed), "total": int(total)}
    print(f"  in-process selftest: {last}")
    check("the in-process selftest passes", done.returncode == 0 and passed == total)
    judged = subprocess.run(
        [sys.executable, "-X", "utf8", "-m", "alcorlang.referee", "--selftest"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    verdict = judged.stdout.strip().splitlines()[-1]
    print(f"  referee self-test: {textwrap.shorten(verdict, 90, placeholder=' ...')}")
    check(
        "the referee can say no: a stub that is wrong on every axis fails every test",
        judged.returncode == 0 and "0/7" in judged.stdout and "SELFTEST: PASS" in judged.stdout,
    )


def demo_selfhost() -> None:
    section("9. Self-hosting: an interpreter written in AlcorLang")
    host = selfhost.host_source()
    blocks = sum(1 for line in host.splitlines() if line.startswith("PROGRAM "))
    print(f"  selfhost/alcorlang.alcor: {len(host.splitlines())} lines, {blocks} PROGRAM blocks")
    check(
        "its string library is an exact copy of selfhost/alcorstr.alcor",
        selfhost.library_in_sync(),
    )
    verdicts: dict[str, int] = {}
    manifest = json.loads((PROGRAMS / "corpus.json").read_text(encoding="utf-8"))
    for case in manifest["programs"]:
        if case["mode"] != "run":
            continue
        source = (PROGRAMS / case["file"]).read_text(encoding="utf-8")
        tape = "".join(line + "\n" for line in case.get("input", []))
        kind = selfhost.compare(source, tape).kind
        verdicts[kind] = verdicts.get(kind, 0) + 1
    print(f"  program corpus on both interpreters: {verdicts}")
    check("no program disagrees between the two interpreters", "mismatch" not in verdicts)
    counts, mismatches = selfhost.sweep(stride=25)
    print(f"  operator sweep (every 25th of 1650 programs): {dict(counts)}")
    check("the sampled operator sweep has zero mismatches", not mismatches)
    loop = "LET $i 0\nLABEL top\nEMIT $i\nLET $i ADD $i 1\nBRANCH LT $i 3 top\nEND PROGRAM"
    headers = (
        "PROGRAM Main",
        "PROGRAM Main WITH profile=complete",
        "PROGRAM Main WITH profile=complete authority=conformance",
    )
    print("  the same loop under three headers, run by the self-hosted interpreter:")
    outcomes = []
    for header in headers:
        first_line = selfhost.compare(header + "\n" + loop).hosted.split("\n")[0]
        outcomes.append(first_line)
        print(f"      {textwrap.shorten(header, 56):<58} -> {textwrap.shorten(first_line, 40)}")
    check(
        "the halting rule holds when the interpreter is itself an AlcorLang program",
        outcomes[0].startswith("COMPILE-ERROR")
        and outcomes[1] == "REFUSED unsigned_complete"
        and outcomes[2] == "0",
    )
    effect = selfhost.compare('PROGRAM\nWRITE Message "x" TO File t.txt\nEND PROGRAM\n')
    print(f"  an effect on the self-hosted interpreter: {effect.hosted.split(':')[0]}")
    check("effects are refused out loud, never faked", effect.kind == "refused-by-design")


SHOWN_PROGRAMS = (
    ("quorum_gate.alcor", "", "Four votes, four verdicts: veto beats everything."),
    ("capped_backoff.alcor", "", "Retry delays that double and stop at a cap."),
    ("backoff_v3.alcor", "3", "v3 syntax, input 3: lowered to the same core."),
    ("runaway.alcor", "", "A loop with no exit, stopped only by fuel."),
)
TRACE_STEPS_SHOWN = 150


def program_entry(filename: str, tape_input: str, caption: str) -> dict[str, Any]:
    """Run one shipped program for real and describe the run for the viewer.

    Args:
        filename: A file in ``programs/``.
        tape_input: Text given to the program as its input.
        caption: One line saying why the program is in the demo.

    Returns:
        The source, output, metered cost, lint result and the first steps of the trace.
    """
    source = (PROGRAMS / filename).read_text(encoding="utf-8")
    metered = alcorlang.run_metered(source, tape_input)
    traced = alcorlang.run_traced(source, tape_input, max_steps=TRACE_STEPS_SHOWN)
    done = cli("lint", f"programs/{filename}", "--format", "json")
    lint = json.loads(done.stdout)
    diagnostics = [
        {
            key: d[key]
            for key in ("rule", "severity", "line", "column", "message", "hint")
            if key in d
        }
        for d in lint["diagnostics"]
    ]
    return {
        "file": filename,
        "caption": caption,
        "input": tape_input,
        "source": source,
        "output": metered["tape"].splitlines(),
        "profile": metered["profile"],
        "steps": metered["steps"],
        "fuel": metered["fuel"],
        "headroom": metered["headroom"],
        "trap": metered["trap"],
        "lint": {"summary": lint["summary"], "diagnostics": diagnostics},
        "trace": traced["steps"],
        "trace_shown": len(traced["steps"]),
    }


def as_viewer_script(component: str, text: str) -> str:
    """Wrap a JSON summary as the script the viewer loads straight from disk.

    A script tag works from file:// where fetch() does not, so the viewer reads this form.

    Args:
        component: The component name for the header comment.
        text: The JSON text.

    Returns:
        JavaScript that assigns the summary to ``window.ALCOR_RUN``.
    """
    return (
        f"/**\n * Sample run of the {component} demo, from `python demo/run_demo.py --json`.\n"
        " * Generated: regenerate it instead of editing it.\n */\n"
        f"window.ALCOR_RUN = {text};\n"
    )


def write_summary(path: Path) -> None:
    """Write the JSON summary of this run for the viewer.

    The file is meant for a public page, so it fails closed: if anything that looks like a drive
    letter, a home directory or a loopback address got in, nothing is written.

    Args:
        path: Where to write the summary.

    Raises:
        SystemExit: If the summary contains something that looks like a private path.
    """
    summary = {
        "schema": "alcor.lang.demo-summary.v1",
        "component": "AlcorLang",
        "programs": [program_entry(*shown) for shown in SHOWN_PROGRAMS],
        "conformance": CONFORMANCE,
        "sections": SECTIONS,
    }
    text = json.dumps(summary, indent=1)
    if re.search(r"[A-Za-z]:[\\/]|/Users/|/home/|127\.0\.0\.1", text):
        raise SystemExit("refusing to write a summary that contains a private-looking path")
    if path.suffix == ".js":
        text = as_viewer_script("AlcorLang", text)
    path.write_text(text.rstrip("\n") + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the AlcorLang demo.")
    parser.add_argument("--json", type=Path, help="also write a JSON summary of the run here")
    options = parser.parse_args()
    print("AlcorLang demo: every line below is computed now.")
    parts = (
        demo_policies,
        demo_v3,
        demo_halting,
        demo_lint,
        demo_lowering,
        demo_gate,
        demo_hosted,
        demo_conformance,
        demo_selfhost,
    )
    for part in parts:
        part()
    failed = [label for label, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS)} checks, {len(failed)} failed")
    for label in failed:
        print(f"  FAILED: {label}")
    if options.json is not None:
        write_summary(options.json)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
