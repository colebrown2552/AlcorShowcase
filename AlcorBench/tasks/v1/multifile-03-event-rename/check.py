#!/usr/bin/env python3
"""Acceptance check. Run with the work directory as cwd."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

WORK = os.getcwd()
# This check's own folder. Nothing under it is ever passed to the code under test.
TASK_DIR = Path(__file__).resolve().parent
# Code under test runs with this explicit minimal environment, never the inherited one.
CHILD_ENV = {
    "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUTF8": "1",
}
MARK = "@@RESULT@@"
FAILS = []

_PRELUDE = '''
import json, sys
sys.path.insert(0, %r)
_R = {}
def case(name, fn):
    try:
        _R[name] = ["ok", fn()]
    except Exception as e:
        _R[name] = ["err", type(e).__name__, str(e)[:160]]
'''


def probe(body, timeout=20):
    """Run python code against the work dir in a subprocess; return dict of case results."""
    code = _PRELUDE % WORK + body + "\nprint(%r + json.dumps(_R, default=repr))\n" % MARK
    try:
        p = subprocess.run([sys.executable, "-B", "-c", code], cwd=WORK, env=CHILD_ENV, capture_output=True,
                           text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "code under test timed out"
    for line in reversed(p.stdout.splitlines()):
        if line.startswith(MARK):
            return json.loads(line[len(MARK):]), None
    tail = (p.stderr.strip().splitlines() or ["no output, exit %s" % p.returncode])[-1]
    return None, "could not run code under test: " + tail[:200]


def run_cmd(args, stdin=None, cwd=None, timeout=20):
    """Run a command; return (code, stdout, stderr) or None on timeout."""
    try:
        p = subprocess.run(args, cwd=cwd or WORK, env=CHILD_ENV, input=stdin, capture_output=True, text=True,
                           timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    return p.returncode, p.stdout, p.stderr


def expect(res, name, want):
    got = res.get(name)
    if want and want[0] == "err":
        ok = bool(got) and got[0] == "err" and got[1] == want[1]
    else:
        ok = got == want
    if not ok:
        FAILS.append("%s: expected %r, got %r" % (name, want, got))


def fail(msg):
    FAILS.append(msg)


def finish():
    if FAILS:
        for line in FAILS[:8]:
            print("FAIL " + line)
        if len(FAILS) > 8:
            print("... and %d more" % (len(FAILS) - 8))
        sys.exit(1)
    print("ok")
    sys.exit(0)


def need(res, err):
    if res is None:
        print("FAIL " + err)
        sys.exit(1)
    return res


def run_visible_tests():
    """The project's own tests (protected from edits) must still pass."""
    if not os.path.isdir(os.path.join(WORK, "tests")):
        return
    r = run_cmd([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"], timeout=40)
    if r is None:
        fail("existing tests timed out")
    elif r[0] != 0:
        fail("existing tests fail: " + (r[2].strip().splitlines() or ["?"])[-1][:150])

# ---- task-specific checks ----
res = need(*probe(r'''
import copy, json, os
from orders import Ledger, SchemaError, dispatch, validate
from orders import events
case("emitted", lambda: events.payment_received("B-77", 450, "voucher"))
case("validate_new", lambda: validate(events.payment_received("B-77", 450, "voucher")))
legacy = {"event": "payment_received", "version": 1,
          "payload": {"order_id": "B-77", "amount_cents": 450, "method": "voucher"}}
case("validate_legacy", lambda: validate(copy.deepcopy(legacy)))
def flow():
    ledger = Ledger()
    dispatch(events.order_placed("B-77", 1000), ledger)
    sent = copy.deepcopy(legacy)
    dispatch(sent, ledger)
    after_legacy = dict(ledger.orders["B-77"])
    dispatch(events.payment_received("B-77", 550, "card"), ledger)
    return [after_legacy["paid_cents"], after_legacy["status"], ledger.orders["B-77"]["status"],
            ledger.orders["B-77"]["paid_cents"], sent == legacy]
case("flow", flow)
def legacy_bad_payload():
    bad = copy.deepcopy(legacy); bad["payload"]["amount_cents"] = "450"
    led = Ledger(); dispatch(events.order_placed("B-77", 1000), led)
    dispatch(bad, led)
case("legacy_bad_payload", legacy_bad_payload)
def legacy_extra_field():
    bad = copy.deepcopy(legacy); bad["payload"]["currency"] = "EUR"
    led = Ledger(); dispatch(events.order_placed("B-77", 1000), led)
    dispatch(bad, led)
case("legacy_extra_field", legacy_extra_field)
case("unknown", lambda: dispatch({"event": "order.refunded", "version": 1, "payload": {}}, Ledger()))
def schema_file():
    with open(os.path.join(%r, "orders", "schema", "events.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    return [sorted(data["events"]), data["events"].get("order.paid", {}).get("payload"),
            data["events"].get("order.paid", {}).get("description")]
case("schema_file", schema_file)
def others_untouched():
    led = Ledger()
    dispatch(events.order_placed("C-1", 5), led)
    dispatch(events.order_shipped("C-1", "UPS"), led)
    return led.orders["C-1"]["status"]
case("others", others_untouched)
''' % WORK))
expect(res, "emitted", ["ok", {"event": "order.paid", "version": 1,
                               "payload": {"order_id": "B-77", "amount_cents": 450, "method": "voucher"}}])
expect(res, "validate_new", ["ok", None])
expect(res, "validate_legacy", ["err", "SchemaError"])
expect(res, "flow", ["ok", [450, "partially_paid", "paid", 1000, True]])
expect(res, "legacy_bad_payload", ["err", "SchemaError"])
expect(res, "legacy_extra_field", ["err", "SchemaError"])
expect(res, "unknown", ["err", "SchemaError"])
expect(res, "schema_file", ["ok", [["order.paid", "order.placed", "order.shipped"],
                                   {"order_id": "string", "amount_cents": "integer", "method": "string"},
                                   "A payment for an order was captured."]])
expect(res, "others", ["ok", "shipped"])
run_visible_tests()
finish()
