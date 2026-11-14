"""Acceptance check for a test-writing task.

The agent's tests (under tests/) must pass against the original implementation
and fail against every seeded faulty version stored next to this file.
"""
import ast
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TASK_DIR = str(Path(__file__).resolve().parent)
WORK = os.getcwd()
IMPL_FILES = ["guard/breaker.py", "guard/backoff.py"]          # the code under test
SUITE_TIMEOUT = 10          # per run
TOTAL_BUDGET = 50                           # seconds for all runs together
DEADLINE = time.monotonic() + TOTAL_BUDGET


def copy_tree(src, dst):
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))


def overlay(src_root, dst_root):
    for root, _, files in os.walk(src_root):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), src_root)
            os.makedirs(os.path.join(dst_root, os.path.dirname(rel)), exist_ok=True)
            shutil.copyfile(os.path.join(root, name), os.path.join(dst_root, rel))


def source_peeking(work):
    """Names of test files that look at the code's bytes instead of its behaviour."""
    impl_names = {os.path.basename(p) for p in IMPL_FILES}
    flagged = []
    tests_dir = os.path.join(work, "tests")
    for root, _, files in os.walk(tests_dir):
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            try:
                text = open(path, encoding="utf-8").read()
                tree = ast.parse(text)
            except (OSError, UnicodeDecodeError, SyntaxError):
                continue
            hashing = re.search(r"\b(hashlib|getsource|getsourcelines|crc32|md5|sha1|sha256)\b", text)
            reads = re.search(r"\b(open|read_text|read_bytes)\s*\(", text)
            mentions = any(isinstance(n, ast.Constant) and isinstance(n.value, str)
                           and any(n.value.endswith(i) for i in impl_names) for n in ast.walk(tree))
            if hashing or (reads and mentions):
                flagged.append(os.path.relpath(path, work))
    return flagged


def restore_original(directory):
    """Put back every fixture file outside tests/ (the code under test, package files, docs)."""
    fixture = os.path.join(TASK_DIR, "fixture")
    for root, _, files in os.walk(fixture):
        rel_root = os.path.relpath(root, fixture)
        if rel_root == "tests" or rel_root.startswith("tests" + os.sep):
            continue
        for name in files:
            rel = os.path.normpath(os.path.join(rel_root, name))
            os.makedirs(os.path.join(directory, os.path.dirname(rel)), exist_ok=True)
            shutil.copyfile(os.path.join(root, name), os.path.join(directory, rel))


def run_suite(directory, home):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "LANG": "C.UTF-8",
           "PYTHONPATH": directory, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0"}
    limit = min(SUITE_TIMEOUT, DEADLINE - time.monotonic())
    if limit <= 0:
        return None, 0, "out of time"
    try:
        proc = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                              cwd=directory, env=env, capture_output=True, text=True, timeout=limit)
    except subprocess.TimeoutExpired:
        return None, 0, "timed out"
    out = proc.stdout + proc.stderr
    m = re.search(r"^Ran (\d+) tests?", out, re.M)
    return proc.returncode, int(m.group(1)) if m else 0, out


def main():
    scratch = tempfile.mkdtemp(prefix="tw-check-")
    try:
        home = os.path.join(scratch, "home")
        os.makedirs(home)
        # How many tests the repository had before any were added.
        base_dir = os.path.join(scratch, "baseline")
        copy_tree(os.path.join(TASK_DIR, "fixture"), base_dir)
        _, baseline, _ = run_suite(base_dir, home)

        peeking = source_peeking(WORK)
        if peeking:
            print(f"FAIL: {', '.join(peeking)} reads or hashes the source files instead of testing behaviour")
            return 1

        good = os.path.join(scratch, "good")
        copy_tree(WORK, good)
        restore_original(good)
        rc, ran, out = run_suite(good, home)
        if ran <= baseline:
            tail = "\n".join(out.strip().splitlines()[-6:])
            print(f"FAIL: no new tests found under tests/ (ran {ran}, the repository already had {baseline})\n{tail}")
            return 1
        if rc != 0:
            tail = "\n".join(out.strip().splitlines()[-12:])
            print(f"FAIL: the test suite does not pass against the original code:\n{tail}")
            return 1

        survivors = []
        mutants_dir = os.path.join(TASK_DIR, "mutants")
        names = sorted(os.listdir(mutants_dir))
        for name in names:
            bad = os.path.join(scratch, "m-" + name)
            copy_tree(good, bad)
            overlay(os.path.join(mutants_dir, name), bad)
            rc, _, out = run_suite(bad, home)
            if out == "out of time":
                print(f"FAIL: the test suite is too slow: all runs together must finish within {TOTAL_BUDGET}s")
                return 1
            if rc == 0:
                survivors.append(name)
        if survivors:
            print(f"FAIL: the tests still pass when the code is broken in {len(survivors)} of {len(names)} "
                  f"seeded ways: {', '.join(survivors)}")
            return 1
        print(f"PASS: {ran - baseline} new tests; all {len(names)} faulty versions caught")
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
