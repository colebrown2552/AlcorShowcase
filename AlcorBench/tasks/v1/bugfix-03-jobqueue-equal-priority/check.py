"""Acceptance check: equal priorities are served FIFO without errors."""
import os
import subprocess
import sys


def clean_env(code_dir):
    """Minimal environment for running code from ``code_dir`` (nothing inherited but PATH)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": code_dir,
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}

PROBE = r'''
import os, random, sys
sys.path.insert(0, os.getcwd())
from jobq.job import Job
from jobq.queue import JobQueue
from jobq.worker import run_all

fails = []

def guard(label, fn):
    try:
        return fn()
    except Exception as e:
        fails.append(f"{label}: {type(e).__name__}: {e}")
        return None

# Ties with ids deliberately out of alphabetical order.
def ties():
    q = JobQueue()
    order = ["zeta", "alpha", "mu", "beta", "omega", "kappa"]
    for jid in order:
        q.submit(Job(jid, "thumb", priority=4))
    q.submit(Job("urgent", "report", priority=1))
    if q.peek().job_id != "urgent":
        fails.append("peek() should return the lowest priority number")
    names = [j.job_id for j in q.pending()]
    if names != ["urgent"] + order:
        fails.append(f"pending() order {names}, expected {['urgent'] + order}")
    popped = [q.pop().job_id for _ in range(len(q))]
    if popped != ["urgent"] + order:
        fails.append(f"pop order {popped}, expected {['urgent'] + order}")
guard("equal priorities", ties)

# Cancelling the head of a tie group.
def cancel_head():
    q = JobQueue()
    for jid in ("p3", "p1", "p2"):
        q.submit(Job(jid, "x", priority=2))
    q.cancel("p3")
    if q.peek().job_id != "p1":
        fails.append(f"after cancelling the first of a tie, peek() gave {q.peek().job_id}")
    if [j.job_id for j in q.pending()] != ["p1", "p2"]:
        fails.append("pending() after cancel is wrong")
    if len(q) != 2:
        fails.append(f"len() after cancel is {len(q)}")
guard("cancel within ties", cancel_head)

# Seeded random load: many ties across a few priority levels.
def bulk():
    rng = random.Random(1337)
    q = JobQueue()
    expected = []
    for i in range(400):
        pr = rng.choice([0, 1, 1, 2, 3, 3, 3])
        jid = f"job-{rng.randrange(10**9):09d}-{i}"
        q.submit(Job(jid, "x", priority=pr))
        expected.append((pr, i, jid))
        if i % 37 == 0:
            q.cancel(jid)
            expected.pop()
    expected.sort()
    want = [jid for _, _, jid in expected]
    got_pending = [j.job_id for j in q.pending()]
    if got_pending != want:
        fails.append("pending() order wrong for 400 mixed-priority jobs")
    got = []
    while len(q):
        got.append(q.pop().job_id)
    if got != want:
        fails.append("pop order wrong for 400 mixed-priority jobs")
guard("bulk", bulk)

# Worker: a failed job goes behind the others of its priority.
def worker():
    q = JobQueue()
    calls = {"flaky": 0}
    def flaky(payload):
        calls["flaky"] += 1
        if calls["flaky"] < 3:
            raise RuntimeError("temporary")
    q.submit(Job("f", "flaky", priority=2, max_attempts=5))
    q.submit(Job("b", "ok", priority=2))
    q.submit(Job("c", "ok", priority=2))
    q.submit(Job("late", "ok", priority=9))
    log = run_all(q, {"flaky": flaky, "ok": lambda p: None})
    want = [("f", "retry"), ("b", "ok"), ("c", "ok"), ("f", "retry"), ("f", "ok"), ("late", "ok")]
    if log != want:
        fails.append(f"worker log {log}, expected {want}")
guard("worker requeue", worker)

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
        print("FAIL: queue code did not finish within 20s")
        return 1
    if proc.returncode != 0:
        print((proc.stdout + proc.stderr).strip()[-1500:] or f"FAIL: probe exited {proc.returncode}")
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
