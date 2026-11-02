"""End-to-end demo of the AlcorCLI gate. Offline, deterministic, no model and no network.

Every model call and every side effect passes one gate. This script drives the real code against a
fake model that listens on loopback, and prints what each step proves:

    1. a .alcor program decides, and the decision is bound to its inputs by a receipt
    2. a model call is routed to a lane, sent over the guarded transport, and receipted
    3. the transport is strict about what comes back: truncated, malformed, redirected or stalled
    4. refusals carry reason codes: a remote endpoint, a path outside the workspace, a forbidden
       command, an effect nobody enabled, a protected input
    5. an admitted effect is read back from disk and receipted
    6. the agent loop: refusals are data, and a claim of DONE is checked
    7. memory admits a row by where its claim came from, and a lesson waits for the operator
    8. a goal can only finish by its own check
    9. the fallback lane is coordination only
   10. the receipt chain verifies, and an edited row is found
   11. the HTTP endpoint refuses an unauthenticated non-loopback bind

Run from the repository root:

    python AlcorCLI/demo/run_demo.py          (PowerShell or bash)

It needs the sibling ``alcorlang`` package to run the .alcor programs. Exit code 0 means every
check held; any failed check prints FAIL and the exit code is 1.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alcorcli import serve  # noqa: E402
from alcorcli.agent import Goal, LocalAgent  # noqa: E402
from alcorcli.ask import ask  # noqa: E402
from alcorcli.config import Config, Scope  # noqa: E402
from alcorcli.errors import PolicyError, ToolDenied, TurnInterrupted  # noqa: E402
from alcorcli.fakes import FakeProvider, RecordingShell, call, say  # noqa: E402
from alcorcli.fallback_lane import fallback_decision  # noqa: E402
from alcorcli.goal import GoalStore  # noqa: E402
from alcorcli.ledger import ThreadLedger  # noqa: E402
from alcorcli.memory import Memory, MemoryLedger  # noqa: E402
from alcorcli.policy import PolicyHost  # noqa: E402
from alcorcli.read_tools import ReadTools  # noqa: E402
from alcorcli.receipts import ReceiptLog  # noqa: E402
from alcorcli.routing import Lane  # noqa: E402
from alcorcli.tools import TOOL_DECISION_SCHEMA, ToolRegistry, tool_cells  # noqa: E402
from alcorcli.transport import OpenAICompatibleTransport, ProviderError, get_json  # noqa: E402
from alcorcli.write_tools import WriteTools  # noqa: E402

FIXED_CLOCK = 1_700_000_000.0
failures: list[str] = []


def section(title: str) -> None:
    print(f"\n== {title}")


def check(label: str, condition: bool) -> None:
    """Print one proof. A check that does not hold is reported, never skipped."""
    print(f"  [{'ok' if condition else 'FAIL'}] {label}")
    if not condition:
        failures.append(label)


def refused(registry: ToolRegistry, name: str, arguments: dict, owner: bool = True) -> ToolDenied:
    try:
        registry.invoke(name, arguments, owner_enabled=owner)
    except ToolDenied as exc:
        return exc
    raise AssertionError(f"{name} was not refused")


def hostile_server(raw: bytes) -> str:
    """Answer one request with raw bytes, then close. Returns the loopback base URL."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)

    def serve_one() -> None:
        connection, _ = listener.accept()
        connection.settimeout(5)
        try:
            connection.recv(4096)
            connection.sendall(raw)
            time.sleep(0.2)
        finally:
            connection.close()
            listener.close()

    threading.Thread(target=serve_one, daemon=True).start()
    return f"http://127.0.0.1:{listener.getsockname()[1]}"


def main() -> int:
    for variable in (serve.TOKEN_ENV, "ALCOR_HOME", "ALCOR_WRITE_ROOTS", "ALCOR_PROTECTED_INPUTS"):
        os.environ.pop(variable, None)
    with tempfile.TemporaryDirectory(prefix="alcorcli-demo-") as scratch:
        run(Path(scratch))
    print("\n" + ("all checks held" if not failures else f"{len(failures)} check(s) FAILED"))
    return 1 if failures else 0


def run(scratch: Path) -> None:
    workspace = scratch / "workspace"
    workspace.mkdir()
    (workspace / "inputs").mkdir()
    config = Config.load(scratch / "state", workspace)
    scope = Scope.for_workspace(workspace, protected=(workspace / "inputs",), environ={})
    policy = PolicyHost()
    receipts = ReceiptLog(config.receipts_path, clock=lambda: FIXED_CLOCK)
    shell = RecordingShell()
    registry = ToolRegistry(
        [*ReadTools(scope).specs(), *WriteTools(scope, receipts).specs(), shell.spec()],
        scope=scope,
        policy=policy,
        receipts=receipts,
    )

    # ------------------------------------------------------------------------------------------
    section("1. A .alcor program decides, and the decision is bound to its inputs")
    cells = tool_cells("write_file", True, {"path": "../escape.txt", "content": "x"}, True, scope)
    envelope = policy.run("tool", cells, TOOL_DECISION_SCHEMA)
    decision, receipt = envelope["decision"], envelope["policy_receipt"]
    program = policy.find_program("tool")
    print(f"  cells: tool_kind={cells['tool_kind']} inside_root={cells['inside_root']}")
    print(f"  decision: verdict={decision['verdict']} reason={decision['reason']}")
    check("the program denied a path outside the workspace", decision["verdict"] == "deny")
    check(
        "the receipt hashes the exact program bytes",
        receipt["program_sha256"] == hashlib.sha256(program.read_bytes()).hexdigest(),
    )
    check("the receipt grants no authority", receipt["effect_authority"] is False)
    schema = TOOL_DECISION_SCHEMA
    policy.verify(envelope, program=program, cells=cells, expect_schema=schema)
    envelope["decision"]["verdict"] = "allow"
    try:
        policy.verify(envelope, program=program, cells=cells, expect_schema=schema)
        tampered = False
    except PolicyError as exc:
        tampered = exc.code == "receipt-decision-mismatch"
    check("a decision edited after the fact no longer matches its receipt", tampered)
    newline = policy.run("tool", {**cells, "tool_kind": "write\nread"}, TOOL_DECISION_SCHEMA)
    check("a cell value with a line break is refused, not run", newline["status"] == "refused")

    # ------------------------------------------------------------------------------------------
    section("2. A model call is routed, sent over loopback, and receipted")
    with FakeProvider(model="demo-model", script=["Paris is the capital of France."]) as provider:
        lanes = {
            "flash": Lane("flash", "small", None),
            "fast": Lane("fast", "mid-size", provider.base),
            "deep": Lane("deep", "large", None),
        }
        answer = ask(
            "What is the capital of France?",
            config=config,
            policy=policy,
            lanes=lanes,
            receipts=receipts,
        )
        sent = provider.requests[0]
    print(f"  route={answer['route']} reason={answer['reason']}")
    print(f"  answer: {answer['answer']}")
    check("cli.alcor chose the only reachable lane", answer["route"] == "fast")
    check(
        "the request asked the provider not to think",
        sent["chat_template_kwargs"] == {"enable_thinking": False},
    )
    check("the answer is advice, not a verified result", answer["task_verified"] is False)
    kinds = [r["kind"] for r in receipts.rows()]
    check(
        "a model.call receipt and an ask receipt were written", kinds[-2:] == ["model.call", "ask"]
    )

    # ------------------------------------------------------------------------------------------
    section("3. The transport is strict about what comes back")
    head = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
    cases = {
        "a chunked reply cut off before its terminator": (
            head + b"Transfer-Encoding: chunked\r\n\r\n" + b'7\r\n{"a": 1\r\n',
            "response-invalid-http",
        ),
        "an object with a repeated key": (
            head + b"Content-Length: 16\r\n\r\n" + b'{"a": 1, "a": 2}',
            "response-invalid-json",
        ),
        "a redirect": (
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/\r\nContent-Length: 0\r\n\r\n",
            "http-302",
        ),
        "a body larger than the limit allows": (
            head + b"Content-Length: 99999999\r\n\r\n",
            "response-exceeds-byte-limit",
        ),
    }
    for label, (raw, code) in cases.items():
        try:
            get_json(hostile_server(raw), "/v1/models", timeout=5)
            seen = "accepted"
        except ProviderError as exc:
            seen = exc.code
        print(f"  {label} -> {seen}")
        check(f"refused: {label}", seen == code)
    silent = socket.socket()
    silent.bind(("127.0.0.1", 0))
    silent.listen(1)
    stop_now = threading.Event()
    threading.Timer(0.3, stop_now.set).start()

    def operator_stop() -> None:
        if stop_now.is_set():
            raise TurnInterrupted("agent-owner-stop")

    started = time.monotonic()
    try:
        get_json(
            f"http://127.0.0.1:{silent.getsockname()[1]}", "/", timeout=30, guard=operator_stop
        )
        cancelled = None
    except TurnInterrupted as exc:
        cancelled = exc.code
    silent.close()
    print(f"  a reply that never comes, then the operator's STOP -> {cancelled}")
    check(
        "a stalled request is cancelled promptly by the guard",
        cancelled == "agent-owner-stop" and time.monotonic() - started < 10,
    )
    package = Path(serve.__file__).parent
    client = r"^\s*(import|from)\s+(urllib\.request|http\.client|socket)\b"
    clients = sorted(
        p.name
        for p in package.glob("*.py")
        if re.search(client, p.read_text(encoding="utf-8"), re.M)
    )
    print(f"  modules that can open an outbound connection: {', '.join(clients)}")
    check(
        "exactly one module in the package can open an outbound connection",
        clients == ["transport.py"],
    )

    # ------------------------------------------------------------------------------------------
    section("4. Refusals carry reason codes")
    remote = ask(
        "hello",
        config=config,
        policy=policy,
        lanes=lanes,
        receipts=receipts,
        endpoint="http://model.example.com:80",
    )
    print(f"  remote endpoint -> {remote['reason']}")
    check(
        "a non-loopback endpoint is refused before any byte is sent",
        remote["reason"] == "endpoint-must-be-http-loopback",
    )
    nothing = {name: Lane(name, name, None) for name in lanes}
    down = ask("hello", config=config, policy=policy, lanes=nothing, receipts=receipts)
    print(f"  no lane up -> {down['reason']}")
    check("with every lane down the program refuses", down["reason"] == "no-reachable-lane")

    outside = refused(registry, "write_file", {"path": "../escape.txt", "content": "x"})
    print(f"  write outside the workspace -> {outside.reason}")
    check(
        "a path outside the workspace is denied",
        outside.reason == "the-path-leaves-the-allowed-roots",
    )
    check("...and nothing was written", not (scratch / "escape.txt").exists())
    forbidden = refused(registry, "shell", {"command": "rm -rf /"})
    print(f"  rm -rf / -> {forbidden.reason}")
    check("a forbidden command pattern is denied outright", forbidden.reason == "forbidden-pattern")
    waiting = refused(registry, "shell", {"command": "git push origin main"}, owner=False)
    print(f"  git push, effects not enabled -> {waiting.verdict} ({waiting.reason})")
    check("an owner-class effect waits for the operator", waiting.verdict == "ask_owner")
    registry.invoke("shell", {"command": "git push origin main"}, owner_enabled=True)
    check(
        "...and runs once enabled, against a target that only records it",
        shell.commands == ["git push origin main"],
    )
    locked = refused(registry, "write_file", {"path": "inputs/spec.md", "content": "x"})
    print(f"  write to a protected input -> {locked.reason}")
    check("a protected input is read-only", locked.reason.startswith("protected-input"))
    empty = scratch / "no-programs"
    empty.mkdir()
    blind = ToolRegistry(
        [WriteTools(scope).specs()[0]],
        scope=scope,
        policy=PolicyHost(programs_dir=empty),
        receipts=receipts,
    )
    unjudged = refused(blind, "write_file", {"path": "x.txt", "content": "x"})
    print(f"  policy program missing -> {unjudged.reason}")
    check(
        "unavailable is deny: a call nobody could judge does not run",
        unjudged.reason.startswith("tool-program-"),
    )
    stop = config.home / "STOP"
    stop.parent.mkdir(parents=True, exist_ok=True)
    stop.write_text("operator stop\n", encoding="utf-8")
    with FakeProvider(model="demo-model", script=["never sent"]) as provider:
        lanes_up = {
            "flash": Lane("flash", "s", None),
            "fast": Lane("fast", "m", provider.base),
            "deep": Lane("deep", "l", None),
        }
        try:
            ask("hello", config=config, policy=policy, lanes=lanes_up, receipts=receipts)
            halted = None
        except TurnInterrupted as exc:
            halted = exc.code
        reached = len(provider.requests)
    stop.unlink()
    print(f"  STOP file present -> {halted}")
    check(
        "the operator's STOP file halts the turn before the model is called",
        halted == "agent-owner-stop" and reached == 0,
    )

    # ------------------------------------------------------------------------------------------
    section("5. An admitted effect is read back and receipted")
    out = json.loads(
        registry.invoke(
            "write_file", {"path": "notes/plan.txt", "content": "step one\n"}, owner_enabled=True
        )
    )
    target = workspace / "notes" / "plan.txt"
    print(f"  wrote {out['path']}: {out['bytes_on_disk']} bytes, read back from disk")
    check(
        "the hash in the result is the hash of the bytes on disk",
        out["sha256"] == hashlib.sha256(target.read_bytes()).hexdigest(),
    )
    rows = receipts.rows()
    check(
        "a tool.decision (allow) precedes the effect.write receipt",
        [r["kind"] for r in rows[-2:]] == ["tool.decision", "effect.write"],
    )
    check(
        "the effect receipt carries hashes, not the file text",
        "step one" not in json.dumps(rows[-1]),
    )

    # ------------------------------------------------------------------------------------------
    section("6. The agent loop: refusals are data, and DONE is checked")
    with FakeProvider(
        model="demo-model",
        script=[
            call("write_file", {"path": "../outside.txt", "content": "x"}, "t1"),
            call("write_file", {"path": "plan.txt", "content": "step one\n"}, "t2"),
            say("DONE"),
            call("read_file", {"path": "plan.txt"}, "t3"),
            say("DONE"),
        ],
    ) as provider:
        agent = LocalAgent(
            ledger=ThreadLedger(
                config.threads_dir / "demo.jsonl", thread_id="demo", clock=lambda: FIXED_CLOCK
            ),
            transport=OpenAICompatibleTransport(provider.base, expected_model="demo-model"),
            model="demo-model",
            goal=Goal("Write plan.txt in the workspace, then say DONE."),
            tools=registry,
            policy=policy,
            receipts=receipts,
            owner_enabled=True,
            recover_tool_errors=True,
            lane="fast",
        )
        result = agent.turn("Write plan.txt and say DONE when it is verified.")
    for entry in result["tool_calls"]:
        state = f"refused ({entry['reason']})" if entry.get("refused") else "ok"
        print(f"  tool call {entry['name']}: {state}")
    print(f"  DONE pushed back {result['verify_pushbacks']} time; ended: {result['ended_because']}")
    check(
        "the first write was refused and the model carried on",
        result["tool_calls"][0].get("refused") is True,
    )
    check("DONE over an unread write was pushed back once", result["verify_pushbacks"] == 1)
    check("after the read-back the claim was accepted", result["reply"] == "DONE" and result["ok"])

    # ------------------------------------------------------------------------------------------
    section("7. Memory admits a row by where its claim came from")
    memory = Memory(
        MemoryLedger(config.memory_path),
        policy,
        heard_path=config.heard_path,
        pending_path=config.pending_path,
        receipts=receipts,
        scope=scope,
    )
    stamped = memory.remember("plan.txt holds the one-step plan", "plan", evidence="notes/plan.txt")
    claim = memory.remember("the integration suite passed and the release was verified")
    memory.note_heard("reviewer", "your release looks perfect and you shipped 12 fixes this week")
    echoed = memory.remember("I shipped 12 fixes this week and the release looks perfect", "self")
    print(f"  with evidence -> {stamped['admission']}")
    print(f"  a result claimed with none -> {claim['admission']}")
    print(f"  an echo of what someone said -> {echoed['admission']}")
    check("evidence stamps the row with the file's hash", stamped["admission"] == "stamped")
    check("a claimed result with no evidence is refused", claim["admission"] == "refused")
    check(
        "a row that echoes what someone said is testimony, attributed",
        echoed["admission"] == "testimony" and echoed["attributed_to"] == "reviewer",
    )
    lesson = (
        "RULE: read a file back before claiming it was changed\n"
        "BECAUSE: a write that was never read is how a claim of success goes unchecked\n"
        "TOPIC: verification\nEND"
    )
    staged = memory.propose(lesson, clock=FIXED_CLOCK)
    before = len(memory.ledger.entries())
    check(
        "a proposed lesson is staged and is not in memory",
        staged["staged"] and not staged["in_memory"] and before == len(memory.ledger.entries()),
    )
    admitted = memory.admit(staged["id"], clock=FIXED_CLOCK)
    check(
        "only the operator's admit command moves it into memory",
        admitted["in_memory"] and len(memory.ledger.entries()) == before + 1,
    )

    # ------------------------------------------------------------------------------------------
    section("8. A goal finishes only by its own check")
    world = {"n": 0, "done": False}

    def runner(command: str) -> dict:
        if command == "SAT":
            return {"rc": 0 if world["done"] else 1, "out": "", "ran": True}
        return {"rc": 0, "out": str(world["n"]), "ran": True}

    goals = GoalStore(
        config.goals_dir, policy, runner=runner, receipts=receipts, clock=lambda: FIXED_CLOCK
    )
    goal = goals.create(
        "get the counter to three", satisfaction="SAT", progress="PROG", goal_id="demo-goal"
    )
    goal = goals.decompose(goal["id"], ["increment", "increment faster"])
    verdicts = [goals.decide(goal)["verdict"]]
    for _ in range(5):
        goals.attempt(goal["id"], lambda: None)
    verdicts.append(goals.decide(goals.load(goal["id"]))["verdict"])
    print(f"  verdicts: {' -> '.join(verdicts)}")
    check(
        "a stalled approach is told to change, not to try harder", verdicts[-1] == "change-approach"
    )
    check(
        "asking to finish while the check fails is refused", goals.finish(goal["id"])["ok"] is False
    )
    world["done"] = True
    check("when the check passes the goal is finished", goals.finish(goal["id"])["ok"] is True)

    # ------------------------------------------------------------------------------------------
    section("9. The fallback lane is coordination only")
    none_up = fallback_decision(
        fast_up=False, deep_up=False, flash_up=False, fallback_installed=True, policy=policy
    )
    one_up = fallback_decision(
        fast_up=True, deep_up=False, flash_up=False, fallback_installed=True, policy=policy
    )
    operations = ", ".join(none_up["machine_operations"])
    print(f"  all lanes down -> {none_up['route']}; operations: {operations}")
    check(
        "with every lane down the fallback names three data-only operations",
        len(none_up["machine_operations"]) == 3,
    )
    check(
        "it never becomes a model or effect authority",
        not none_up["model_authority"] and not none_up["effect_authority"],
    )
    check("any live lane suppresses the fallback", one_up["eligible"] is False)

    # ------------------------------------------------------------------------------------------
    section("10. The receipt chain verifies, and an edited row is found")
    report = receipts.verify()
    counts = Counter(r["kind"] for r in receipts.rows())
    print("  " + ", ".join(f"{k} x{v}" for k, v in sorted(counts.items())))
    check(f"{report['count']} receipts chain from the first to the last", report["ok"])
    copy = ReceiptLog(scratch / "forged.jsonl")
    lines = config.receipts_path.read_text(encoding="utf-8").splitlines()
    forged = lines[:]
    forged[3] = (
        forged[3].replace('"allow"', '"deny"', 1)
        if '"allow"' in forged[3]
        else forged[3].replace("a", "b", 1)
    )
    copy.path.write_text("\n".join(forged) + "\n", encoding="utf-8")
    verdict = copy.verify()
    print(f"  after editing row 4: {verdict['reason']}")
    check(
        "an edited row breaks the chain at that row",
        not verdict["ok"] and verdict["reason"].startswith("row 4"),
    )

    # ------------------------------------------------------------------------------------------
    section("11. The HTTP endpoint refuses an unauthenticated non-loopback bind")
    context = serve.ServerContext(
        config, policy, {n: Lane(n, n, None) for n in ("flash", "fast", "deep")}, receipts
    )
    try:
        serve.make_server("0.0.0.0", 0, context)
        refused_bind = False
    except serve.ServeRefused as exc:
        refused_bind = serve.TOKEN_ENV in str(exc)
    check("binding a routable address without a token is refused", refused_bind)
    httpd = serve.make_server("127.0.0.1", 0, context)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{httpd.server_address[1]}/programs", timeout=20
        ) as response:
            names = sorted(p["name"] for p in json.loads(response.read())["programs"])
    finally:
        httpd.shutdown()
        httpd.server_close()
    check("a loopback bind needs no token and serves the program list", "tool" in names)


if __name__ == "__main__":
    sys.exit(main())
