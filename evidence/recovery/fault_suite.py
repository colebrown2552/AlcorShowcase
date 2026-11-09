#!/usr/bin/env python3
"""Sandboxed fault-injection suite for interrupted work. Python 3.12 stdlib only.

    python3 -B fault_suite.py [--quick] --seed S --workdir DIR [--receiver URL] [--trials N] [--inject-duplicate-fault]

Ten fault families (fault_matrix.json, committed beside this script and copied byte-for-byte into DIR). Four families are driven through
AlcorSystem's own task code (tasks.create / renew / sweep / close) in a sandbox ledger DIR/tasks; the rest are labelled simulated in the
matrix because their real seam acts on live stores or services. Every effect goes over HTTP to the effect receiver (--receiver, else an
in-process loopback one); the suite writes DIR/trials.jsonl, receiver.jsonl, manifest.json and tasks/.
"""
import argparse
import hashlib
import http.server
import json
import math
import os
import platform
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = "alcor.recovery.fault-suite.v1"
FULL_LEASE_S, QUICK_LEASE_S = 1.0, 0.3
POOL = 16


class AckLost(Exception):
    """The receiver committed the effect but the reply never reached the caller (injected)."""


# ------------------------------------------------------------------ own loopback receiver (same protocol as the checker's)
class OwnReceiver:
    def __init__(self):
        self.log, self.lock = [], threading.Lock()
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                    tid, eid = body["logical_task_id"], body["effect_id"]
                    assert isinstance(tid, str) and tid and isinstance(eid, str) and eid and self.path == "/effect"
                except (ValueError, KeyError, AssertionError, TypeError):
                    return self._send(400, {"committed": False})
                with outer.lock:
                    outer.log.append({"logical_task_id": tid, "effect_id": eid})
                    n = sum(1 for e in outer.log if e["logical_task_id"] == tid)
                self._send(200, {"committed": True, "n": n})

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                tid = (urllib.parse.parse_qs(u.query).get("logical_task_id") or [""])[0]
                with outer.lock:
                    n = sum(1 for e in outer.log if e["logical_task_id"] == tid)
                self._send(200, {"count": n} if u.path == "/effects" else {"error": "not found"})

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


# ------------------------------------------------------------------ the suite
class Suite:
    def __init__(self, a, tasks, receiver_url, tmp):
        self.a, self.tasks, self.url, self.tmp = a, tasks, receiver_url.rstrip("/"), tmp
        self.lease = QUICK_LEASE_S if a.quick else FULL_LEASE_S
        self.hold = 3 * self.lease  # lease of tasks that must stay alive while a trial runs (renewed as a heartbeat)
        self.provider_timeout = 0.1 if a.quick else 0.2
        self.sent, self.sent_lock = [], threading.Lock()  # the suite's own record of every effect it sent
        self.guard, self.guard_lock = set(), threading.Lock()  # in-run effect-id guard (in memory, not durable across runs) (duplicate-delivery)
        self.sweep_lock = threading.Lock()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.dead = socket.socket()  # a fake provider that never answers
        self.dead.bind(("127.0.0.1", 0))
        self.dead.listen(512)
        (tmp / "reservations").mkdir()

    # -------- receiver client
    def post_effect(self, tid, eid, drop_ack=False):
        req = urllib.request.Request(self.url + "/effect", data=json.dumps({"logical_task_id": tid, "effect_id": eid}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with self.opener.open(req, timeout=10) as r:
            body = json.loads(r.read())
        if not body.get("committed"):
            raise RuntimeError("receiver refused the effect")
        with self.sent_lock:
            self.sent.append({"logical_task_id": tid, "effect_id": eid})
        if drop_ack:
            raise AckLost(tid)
        return body

    def count(self, tid):
        q = urllib.parse.urlencode({"logical_task_id": tid})
        with self.opener.open(f"{self.url}/effects?{q}", timeout=10) as r:
            return int(json.loads(r.read())["count"])

    # -------- real ledger helpers (AlcorSystem tasks.py)
    def sweep(self):
        with self.sweep_lock:
            try:
                return self.tasks.sweep()
            except self.tasks.TaskError:
                return None

    def terminal_status(self, tid):
        return ((self.tasks.load(tid).get("terminal") or {}).get("status"))

    def wait_abandoned(self, tid, give_up_s=15.0):
        """Wait for the lease to lapse, then let the real sweep abandon the task. True when the ledger says ABANDONED."""
        end = time.monotonic() + give_up_s
        while time.monotonic() < end:
            lu = self.tasks.load(tid).get("lease_until")
            wait = (float(lu) - time.time()) + 0.05 if lu else 0.0
            if wait > 0:
                time.sleep(wait)
            self.sweep()
            if self.terminal_status(tid) == "ABANDONED":
                return True
            time.sleep(0.05)
        return False

    def new_task(self, tid, key, lease_s):
        return self.tasks.create(f"fault-suite trial {tid}", tid=tid, owner="fault-suite", lease_s=lease_s, dedupe_key=key,
                                 correlation_id=f"cor-{tid}")

    # -------- contracts / receipts (simulated stand-in for swarm_receipt.authentic: contract digest and request id binding)
    @staticmethod
    def contract(tid, attempt):
        body = {"goal": "fault-suite", "task": tid, "attempt": attempt}
        sha = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        return {**body, "contract_sha256": sha, "request_id": "req-" + hashlib.sha256(f"{tid}:{attempt}".encode()).hexdigest()[:16]}

    @staticmethod
    def authentic(receipt, contract):
        if receipt.get("contract_sha256") != contract["contract_sha256"]:
            return "contract_binding"
        if receipt.get("request_id") != contract["request_id"]:
            return "request_id"
        if receipt.get("attempt") != contract["attempt"]:
            return "attempt_binding"
        return None

    # -------- families: each returns (outcome, recovery_s or None)
    def f_before_reservation(self, tid, rng):
        key = "key-" + tid
        self.new_task(tid, key, self.hold)
        t0 = time.perf_counter()  # the worker is cut off here: nothing reserved, nothing sent
        again = self.tasks.create(f"fault-suite trial {tid}", tid=tid + "-r", owner="fault-suite", lease_s=self.hold, dedupe_key=key)
        if again.get("id") != tid or not again.get("deduped"):
            return "failed", None
        self.tasks.renew(tid, self.hold)
        self.post_effect(tid, f"eff-{tid}")
        return "recovered", time.perf_counter() - t0

    def f_after_reservation(self, tid, rng):
        path = self.tmp / "reservations" / f"{tid}.json"
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        with os.fdopen(fd, "w") as f:
            json.dump({"logical_task_id": tid, "effect_id": f"eff-{tid}"}, f)
            f.flush()
            os.fsync(f.fileno())
        t0 = time.perf_counter()  # cut off: reserved, effect not sent
        if self.count(tid) != 0:
            return "failed", None
        res = json.loads(path.read_text())
        try:
            os.close(os.open(str(path) + ".sent", os.O_CREAT | os.O_EXCL | os.O_WRONLY))  # claim the never-started reservation once
        except FileExistsError:
            return "failed", None
        self.post_effect(res["logical_task_id"], res["effect_id"])
        return "recovered", time.perf_counter() - t0

    def f_worker_exit(self, tid, rng):
        self.new_task(tid, "key-" + tid, self.lease)
        t0 = time.perf_counter()  # the worker exits: no renew, no effect
        if not self.wait_abandoned(tid):
            return "failed", None
        rep = tid + "-g2"
        self.new_task(rep, "key-" + rep, self.hold)
        self.post_effect(tid, f"eff-{tid}-g2")  # the replacement sends under the original logical_task_id
        return "recovered", time.perf_counter() - t0

    def f_ack_lost(self, tid, rng):
        try:
            self.post_effect(tid, f"eff-{tid}", drop_ack=True)
        except AckLost:
            pass
        n = self.count(tid)  # reconcile through the receiver; an ambiguous effect is held, never re-sent
        return ("quarantined", None) if n >= 1 else ("failed", None)

    def f_duplicate_delivery(self, tid, rng):
        eid = f"eff-{tid}"
        t0 = time.perf_counter()
        for delivery in (1, 2):
            with self.guard_lock:
                fresh = eid not in self.guard
                self.guard.add(eid)
            if fresh:
                self.post_effect(tid, eid)
            elif self.a.inject_duplicate_fault:
                self.post_effect(tid, f"{eid}-blind{delivery}")  # injected: blindly re-execute
        return "recovered", time.perf_counter() - t0

    def f_stale_lease(self, tid, rng):
        self.new_task(tid, "key-" + tid, self.lease)
        t0 = time.perf_counter()  # generation 1 stops renewing; the old worker stays alive but silent
        if not self.wait_abandoned(tid):
            return "failed", None
        rep = tid + "-g2"
        self.new_task(rep, "key-" + rep, self.hold)
        # the old worker wakes and tries to finish: it must renew its lease first; the real ledger refuses that
        try:
            self.tasks.renew(tid, self.hold)
            fenced = False  # the stale worker was allowed to renew: no fence
        except self.tasks.TaskError:
            fenced = self.terminal_status(tid) == "ABANDONED"
        if not fenced:
            return "failed", None
        # fenced: the late effect is withheld (a worker that cannot renew must not dispatch)
        if self.a.inject_duplicate_fault:
            self.post_effect(tid, f"eff-{tid}-stale")  # injected: the stale worker blindly re-executes
        self.post_effect(tid, f"eff-{tid}-g2")
        return "recovered", time.perf_counter() - t0

    def f_provider_timeout(self, tid, rng):
        t0 = time.perf_counter()
        s = socket.create_connection(self.dead.getsockname(), timeout=self.provider_timeout)
        try:
            s.sendall(b"GET /call HTTP/1.0\r\n\r\n")
            s.recv(1)
            return "failed", None  # the dead provider answered: not the fault we meant
        except socket.timeout:
            pass
        finally:
            s.close()
        if self.count(tid) != 0:
            return "failed", None
        self.post_effect(tid, f"eff-{tid}-retry")
        return "recovered", time.perf_counter() - t0

    def f_out_of_order(self, tid, rng):
        c1, c2 = self.contract(tid, 1), self.contract(tid, 2)
        arrived = [dict(c2), dict(c1)]  # attempt 2 first
        t0 = time.perf_counter()
        ordered = sorted(arrived, key=lambda r: r["attempt"])
        latest = ordered[-1]
        if self.authentic(latest, c2) or self.authentic(ordered[0], c1):
            return "failed", None
        self.post_effect(tid, f"eff-{tid}-a{latest['attempt']}")
        return "recovered", time.perf_counter() - t0

    def f_receipt_mismatch(self, tid, rng):
        c = self.contract(tid, 1)
        self.post_effect(tid, f"eff-{tid}")  # the effect is committed
        bad = dict(c)
        if rng.random() < 0.5:
            bad["contract_sha256"] = "0" * 64
        else:
            bad["request_id"] = "req-forged"
        if not self.authentic(bad, c):
            return "failed", None
        return ("quarantined", None) if self.count(tid) >= 1 else ("failed", None)

    def f_stop(self, tid, rng):
        T = self.tasks
        self.new_task(tid, "key-" + tid, self.hold)
        stop = Path(os.environ["ALCOR_OWNER_STOP"])
        stop.write_text("sandbox STOP\n")
        try:
            if T.halted() != "owner":
                return "failed", None
            refused = []
            for fn in (lambda: T.close(tid, "DONE", "work finished", ["fault-suite evidence"]), lambda: T.sweep()):
                try:
                    fn()
                    refused.append(False)
                except T.TaskError as e:
                    refused.append("stopped" in str(e))
            # pending work is not sent while STOP is set: nothing is posted
        finally:
            stop.unlink(missing_ok=True)
        if not all(refused) or self.terminal_status(tid) == "DONE":
            return "failed", None
        T.close(tid, "CANCELLED", "stop-while-pending", ["STOP was set while work was pending; no effect sent"])
        return "quarantined", None

    # -------- driver
    def run(self, matrix, trials_per_family):
        fn = {"before-reservation": self.f_before_reservation, "after-reservation": self.f_after_reservation,
              "worker-exit-before-dispatch": self.f_worker_exit, "ack-lost": self.f_ack_lost, "duplicate-delivery": self.f_duplicate_delivery,
              "stale-lease-generation": self.f_stale_lease, "provider-timeout": self.f_provider_timeout,
              "out-of-order-receipt": self.f_out_of_order, "receipt-source-mismatch": self.f_receipt_mismatch, "stop-while-pending": self.f_stop}
        ids = [f["id"] for f in matrix["families"]]
        if set(ids) != set(fn):
            raise SystemExit("fault_matrix.json families do not match the suite's families")
        seed = self.a.seed
        jobs = [(fid, n) for fid in ids for n in range(1, trials_per_family + 1)]
        results = {}

        def one(job):
            fid, n = job
            tid = f"{fid}-{seed}-{n:03d}"
            rng = random.Random(f"{seed}/{fid}/{n}")
            try:
                out, rs = fn[fid](tid, rng)
            except Exception as e:  # a crash is a failed trial, kept in the denominator
                sys.stderr.write(f"trial {tid} failed: {type(e).__name__}: {str(e)[:120]}\n")
                out, rs = "failed", None
            results[job] = {"trial": n, "family": fid, "logical_task_id": tid, "outcome": out, "recovery_s": rs if out == "recovered" else None}

        random.Random(seed).shuffle(jobs)
        with ThreadPoolExecutor(POOL) as ex:
            list(ex.map(one, [j for j in jobs if j[0] != "stop-while-pending"]))
        # leave no completed task OPEN with a lapsed lease: one real sweep once the hold leases have run out
        time.sleep(self.hold + 0.1)
        self.sweep()
        for job in sorted(j for j in jobs if j[0] == "stop-while-pending"):  # STOP is a global switch: run these alone, one at a time
            one(job)
        return [results[j] for j in sorted(results, key=lambda j: (ids.index(j[0]), j[1]))]


def pctl(vals, p):
    if not vals:
        return None
    v = sorted(vals)
    return v[min(len(v) - 1, max(0, round((len(v) - 1) * p)))]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--receiver")
    ap.add_argument("--trials", type=int)
    ap.add_argument("--inject-duplicate-fault", action="store_true")
    a = ap.parse_args()
    wd = Path(a.workdir).resolve()
    if not wd.is_dir():
        raise SystemExit("--workdir must be an existing directory")
    if any(wd.iterdir()):
        raise SystemExit("--workdir must be empty")
    tdir, owner_stop, agent_stop = wd / "tasks", wd / "STOP-owner", wd / "STOP-agentic"
    os.environ["ALCOR_TASKS_DIR"], os.environ["ALCOR_OWNER_STOP"], os.environ["ALCOR_AGENTIC_STOP"] = str(tdir), str(owner_stop), str(agent_stop)
    for p in (tdir, owner_stop, agent_stop):
        if wd not in p.resolve().parents:
            raise SystemExit("refusing to run: a sandbox path resolves outside --workdir")
    root = os.environ.get("ALCOR_ROOT")
    if not root:
        raise SystemExit("ALCOR_ROOT is not set")
    sys.path.insert(0, root)
    from AlcorSystem import tasks  # read-only import of the real task code, after the sandbox variables are set
    if wd not in tasks.root().resolve().parents:
        raise SystemExit("refusing to run: tasks.root() is outside --workdir")

    matrix_src = HERE / "fault_matrix.json"
    shutil.copyfile(matrix_src, wd / "fault_matrix.json")
    matrix = json.loads(matrix_src.read_text())
    per = a.trials or (3 if a.quick else 30)
    own = None if a.receiver else OwnReceiver()
    tmp = Path(tempfile.mkdtemp(prefix=".suite-tmp-", dir=wd))
    try:
        suite = Suite(a, tasks, a.receiver or own.url, tmp)
        rows = suite.run(matrix, per)
        sent = suite.sent
        suite.dead.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if own:
            own.close()

    seen = {}
    for e in sent:
        seen[e["logical_task_id"]] = seen.get(e["logical_task_id"], 0) + 1
    fam = {f["id"]: f for f in matrix["families"]}
    # the receiver is the truth for counts: use its own log when we run it, else the suite's record (equal when nothing was hidden)
    if own:
        seen = {}
        for e in own.log:
            seen[e["logical_task_id"]] = seen.get(e["logical_task_id"], 0) + 1
        sent = list(own.log)
    (wd / "trials.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (wd / "receiver.jsonl").write_text("".join(json.dumps({"logical_task_id": e["logical_task_id"], "effect_id": e["effect_id"]}) + "\n" for e in sent))

    def counts(ts):
        v = [t["recovery_s"] for t in ts if t["outcome"] == "recovered"]
        return {"attempted": len(ts), "recovered": len(v), "quarantined": sum(t["outcome"] == "quarantined" for t in ts),
                "failed": sum(t["outcome"] == "failed" for t in ts),
                "duplicate_effects": sum(max(0, seen.get(t["logical_task_id"], 0) - fam[t["family"]]["effects_expected"]) for t in ts),
                "p95": pctl(v, 0.95)}

    families = []
    for f in matrix["families"]:
        ts = [t for t in rows if t["family"] == f["id"]]
        families.append({"id": f["id"], "cohort": f["cohort"], "seam": f["seam"], "trials": len(ts),
                         "recovered": sum(t["outcome"] == "recovered" for t in ts), "quarantined": sum(t["outcome"] == "quarantined" for t in ts),
                         "failed": sum(t["outcome"] == "failed" for t in ts), "effects_expected": f["effects_expected"] * len(ts),
                         "effects_observed": sum(seen.get(t["logical_task_id"], 0) for t in ts),
                         "duplicate_effects": sum(max(0, seen.get(t["logical_task_id"], 0) - f["effects_expected"]) for t in ts)})
    keys = ("trials", "recovered", "quarantined", "failed", "duplicate_effects", "effects_expected", "effects_observed")
    sel = lambda seam, c: counts([t for t in rows if (seam is None or fam[t["family"]]["seam"] == seam) and fam[t["family"]]["cohort"] == c])
    vals = [t["recovery_s"] for t in rows if t["outcome"] == "recovered"]
    try:
        commit = subprocess.run(["git", "-C", str(HERE), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        commit = ""
    manifest = {
        "schema": SCHEMA, "date": time.strftime("%Y-%m-%d"), "seed": a.seed, "families": families,
        "totals": {k: sum(f[k] for f in families) for k in keys},
        "cohorts": {"retry_safe": sel(None, "retry_safe"), "quarantine": sel(None, "quarantine"),
                    "real": {"retry_safe": sel("real", "retry_safe"), "quarantine": sel("real", "quarantine")},
                    "simulated": {"retry_safe": sel("simulated", "retry_safe"), "quarantine": sel("simulated", "quarantine")}},
        "lease": {"lease_s": suite.lease, "renew": "heartbeat renew (tasks.renew) on live tasks; hold lease_s_live = 3 x lease_s", "lease_s_live": suite.hold},
        "recovery_seconds": {"p50": pctl(vals, 0.5), "p95": pctl(vals, 0.95), "n": len(vals)},
        "reproduce_quick": "python3 -B fault_suite.py --quick --seed 20261108", "reproduce_full": "python3 -B fault_suite.py --seed 20261108",
        "source_commit": commit,
        "sandbox": "Ledger, receipts and both STOP files live in tasks/, STOP-owner and STOP-agentic inside --workdir (tasks.root() checked to be inside it); "
                   "only AlcorSystem tasks.py is imported; no process control, no systemd, no live worker or home-directory state is used; "
                   "the only network is loopback to the effect receiver; the suite starts no processes of its own except one git rev-parse.",
        "limitations": "A finite suite shows no more than the trials it ran: trials per family are small and the faults are injected at fixed points, "
                       "not found by chance. Real-seam families (before-reservation, worker-exit-before-dispatch, stale-lease-generation, "
                       "stop-while-pending) exercise tasks.py create/renew/sweep/close in a sandbox ledger; all other families (after-reservation, "
                       "ack-lost, duplicate-delivery, provider-timeout, out-of-order-receipt, receipt-source-mismatch) are simulated in the suite. "
                       "tasks.py has no worker-generation fence, so the old worker's late effect is withheld by the suite after the real ledger refuses its tasks.renew on the ABANDONED task; no receiver-side generation fence is tested. The fake receiver is "
                       "a loopback stand-in, not a real provider. Finished real tasks are not marked DONE (the DONE audit needs verified evidence the "
                       "sandbox does not model); a sweep after the run abandons their lapsed leases. STOP trials are reported as quarantined, never recovered, although the matrix lists stop-while-pending as retry_safe, so the retry-safe recovery rates (overall and real-seam) are lowered by those trials: quote them with the STOP family's 0 expected effects in mind. The duplicate-delivery guard is an in-run, in-memory set. "
                       "Recovery times for lease families include the lease wait. Retry-safe recovery rates should be quoted from the real-seam cohort "
                       "or with the simulated share stated.",
        "environment": {"python": platform.python_version(), "platform": platform.system() + " " + platform.machine(), "pool_threads": POOL,
                        "quick": a.quick, "trials_per_family": per, "inject_duplicate_fault": a.inject_duplicate_fault},
    }
    (wd / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"trials": len(rows), "recovered": manifest["totals"]["recovered"], "duplicate_effects": manifest["totals"]["duplicate_effects"]}))


if __name__ == "__main__":
    main()
