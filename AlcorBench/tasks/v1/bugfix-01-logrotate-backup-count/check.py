"""Acceptance check: rotation keeps exactly backup_count generations."""
import os
import subprocess
import sys


def clean_env(code_dir):
    """Minimal environment for running code from ``code_dir`` (nothing inherited but PATH)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": code_dir,
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}

PROBE = r'''
import os, sys, tempfile
sys.path.insert(0, os.getcwd())
from logrot.rotator import rotate, append_line

fails = []

def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()

def backups(d, base):
    out = []
    for name in os.listdir(d):
        if name.startswith(base + ".") and name[len(base) + 1:].isdigit():
            out.append(int(name[len(base) + 1:]))
    return sorted(out)

for count in (1, 2, 3, 4, 7):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "svc.log")
        gens = count + 4
        for g in range(gens):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(f"generation {g}\n")
            rotate(path, count)
        got = backups(d, "svc.log")
        if got != list(range(1, count + 1)):
            fails.append(f"backup_count={count}: backups on disk are {got}")
            continue
        for k in range(1, count + 1):
            want = f"generation {gens - k}\n"
            have = read(f"{path}.{k}")
            if have != want:
                fails.append(f"backup_count={count}: {os.path.basename(path)}.{k} holds {have!r}, expected {want!r}")
                break
        if read(path) != "":
            fails.append(f"backup_count={count}: live log not empty after rotation")

# Fewer rotations than the limit: no gaps, nothing invented.
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "a.log")
    for g in range(2):
        with open(path, "w") as fh:
            fh.write(f"g{g}\n")
        rotate(path, 6)
    if backups(d, "a.log") != [1, 2] or read(path + ".1") != "g1\n" or read(path + ".2") != "g0\n":
        fails.append("two rotations with backup_count=6 should give .1 (newest) and .2")

# Lowering the limit discards backups numbered above it.
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "b.log")
    for g in range(6):
        with open(path, "w") as fh:
            fh.write(f"g{g}\n")
        rotate(path, 6)
    with open(path, "w") as fh:
        fh.write("g6\n")
    rotate(path, 3)
    got = backups(d, "b.log")
    if got != [1, 2, 3] or read(path + ".3") != "g4\n":
        fails.append(f"after lowering backup_count to 3: backups {got}, .3 holds {read(path + '.3')!r} (expected 'g4')")

# Edge: zero backups truncates only.
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "c.log")
    with open(path, "w") as fh:
        fh.write("data\n")
    rotate(path, 0)
    if backups(d, "c.log") or read(path) != "":
        fails.append("backup_count=0 should truncate without keeping backups")

# Through append_line with a size limit.
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "w.log")
    for i in range(12):
        append_line(path, f"line{i:02d}", max_bytes=7, backup_count=4)
    got = backups(d, "w.log")
    if got != [1, 2, 3, 4] or read(path) != "line11\n" or read(path + ".4") != "line07\n":
        fails.append(f"append_line with backup_count=4 left backups {got}")

for f in fails:
    print("FAIL:", f)
sys.exit(1 if fails else 0)
'''


def main():
    env = clean_env(os.getcwd())
    try:
        proc = subprocess.run([sys.executable, "-c", PROBE], cwd=os.getcwd(), env=env,
                              capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        print("FAIL: rotation code did not finish within 20s")
        return 1
    out = (proc.stdout + proc.stderr).strip()
    if proc.returncode != 0:
        print(out[-1500:] or f"FAIL: probe exited {proc.returncode}")
        return 1
    try:
        tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                               cwd=os.getcwd(), env=env, capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        print("FAIL: existing tests timed out")
        return 1
    if tests.returncode != 0:
        print("FAIL: existing tests in tests/ fail:\n" + tests.stderr[-800:])
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
