"""Command dispatch: the one entry point every lane and tool is reachable from.

A command nothing can reach does not exist, so registering a command and making it reachable are
the same act: ``COMMANDS`` below is the only table, and ``main`` is the only dispatcher.

Exit codes: 0 for success, 1 when the gate refused or a check said no, 2 for a usage error or a
gate failure, 64 for an unknown command. Every command prints JSON except ``ask`` and ``agent``,
which print the answer and keep the JSON behind ``--json``.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from . import __version__
from .agent import Goal, LocalAgent
from .ask import ask
from .config import Config
from .digest import sha256_hex
from .errors import AlcorError, PolicyError, ToolDenied
from .fakes import DEFAULT_REPLY, FakeProvider, RecordingShell
from .fallback_lane import FallbackLaneError, fallback_decision
from .goal import GoalStore, command_runner
from .ledger import ThreadLedger
from .memory import Memory, MemoryLedger
from .policy import PolicyHost
from .read_tools import ReadTools
from .receipts import ReceiptLog
from .routing import Lane, lanes_from_env, probe_all
from .serve import ServerContext, serve
from .tools import ToolRegistry, ToolSpec, admit_tool_call
from .transport import OpenAICompatibleTransport, request_defaults
from .write_tools import WriteTools

UNKNOWN_COMMAND = 64


class UsageError(AlcorError):
    """The command line was malformed."""


class _Parser(argparse.ArgumentParser):
    """An argument parser that raises instead of exiting, so ``main`` can return a code."""

    def error(self, message: str) -> Any:
        raise UsageError("usage", message)


@dataclass
class Context:
    """Everything a command needs, built once per invocation."""

    config: Config
    policy: PolicyHost
    receipts: ReceiptLog
    lanes: dict[str, Lane]
    out: TextIO
    err: TextIO
    clock: Callable[[], float]

    def emit(self, value: Any) -> None:
        """Print a value as sorted, indented JSON."""
        print(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False), file=self.out)


def _lane_overrides(
    lanes: dict[str, Lane], bases: Sequence[str], models: Sequence[str]
) -> dict[str, Lane]:
    """Apply ``--lane-base NAME=URL`` and ``--lane-model NAME=MODEL`` over the environment."""
    updated = dict(lanes)
    for item in bases:
        name, _, value = item.partition("=")
        if name not in updated or not value:
            raise UsageError(
                "usage", f"--lane-base expects NAME=URL with NAME in {sorted(updated)}"
            )
        updated[name] = Lane(**{**updated[name].__dict__, "base": value})
    for item in models:
        name, _, value = item.partition("=")
        if name not in updated:
            raise UsageError(
                "usage", f"--lane-model expects NAME=MODEL with NAME in {sorted(updated)}"
            )
        updated[name] = Lane(**{**updated[name].__dict__, "expected_model": value})
    return updated


def _cells(pairs: Sequence[str]) -> dict[str, str]:
    cells: dict[str, str] = {}
    for pair in pairs:
        key, separator, value = pair.partition("=")
        if not separator or not key:
            raise UsageError("usage", f"cell {pair!r} must be NAME=VALUE")
        cells[key] = value
    return cells


def _json_arg(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except ValueError as exc:
        raise UsageError("usage", f"--args is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise UsageError("usage", "--args must be a JSON object")
    return value


def _memory(ctx: Context) -> Memory:
    cfg = ctx.config
    return Memory(
        MemoryLedger(cfg.memory_path),
        ctx.policy,
        heard_path=cfg.heard_path,
        pending_path=cfg.pending_path,
        receipts=ctx.receipts,
        scope=cfg.scope,
    )


def _tools(
    ctx: Context, *, allow_write: bool, allow_shell: bool, shell: RecordingShell | None = None
) -> ToolRegistry:
    """Assemble the tool set. Read tools are always present; effects are opt-in per invocation."""
    scope = ctx.config.scope
    memory = _memory(ctx)
    specs: list[ToolSpec] = [*ReadTools(scope).specs(), memory.specs()[0]]
    specs.append(
        ToolSpec(
            name="ask_owner",
            description="Record a question for the human operator. It is always allowed.",
            handler=lambda a: _record_question(ctx, str(a.get("question") or "")),
            parameters={
                "type": "object",
                "properties": {"question": {"type": "string"}},
                "required": ["question"],
            },
        )
    )
    if allow_write:
        specs += [*WriteTools(scope, ctx.receipts).specs(), memory.specs()[1]]
    if allow_shell:
        specs.append((shell or RecordingShell()).spec())
    return ToolRegistry(specs, scope=scope, policy=ctx.policy, receipts=ctx.receipts)


def _record_question(ctx: Context, question: str) -> dict[str, Any]:
    """Record a question for the operator as a hash and a length, never as text."""
    body = {"question_sha256": sha256_hex(question), "chars": len(question)}
    return {
        "ok": True,
        "recorded": True,
        "receipt_id": ctx.receipts.append("owner.question", body)["id"],
    }


# -- commands ----------------------------------------------------------------------------------


def _cmd_doctor(args: argparse.Namespace, ctx: Context) -> int:
    """Report what is configured and what works. Non-mutating."""
    report: dict[str, Any] = {
        "schema": "alcor.cli.doctor.v1",
        "package": __version__,
        "python": sys.version.split()[0],
        "state_dir": str(ctx.config.home),
        "workspace": str(ctx.config.scope.workspace),
        "effect_authority": False,
    }
    try:
        ctx.policy.runtime()
        report["policy_runtime"] = {"available": True}
    except PolicyError as exc:
        report["policy_runtime"] = {"available": False, "reason": exc.code, "detail": exc.detail}
    report["programs"] = [
        {**p, "check": ctx.policy.check(p["name"]).get("status")} for p in ctx.policy.programs()
    ]
    states = probe_all(ctx.lanes, args.probe_timeout)
    report["lanes"] = {k: {"up": v.up, "detail": v.detail or "up"} for k, v in states.items()}
    try:
        report["fallback"] = fallback_decision(
            fast_up=states["fast"].up,
            deep_up=states["deep"].up,
            flash_up=states["flash"].up,
            fallback_installed=args.fallback_installed,
            policy=ctx.policy,
        )
    except FallbackLaneError as exc:
        report["fallback"] = {"error": str(exc)}
    report["receipts"] = ctx.receipts.verify()
    ctx.emit(report)
    return 0 if report["policy_runtime"]["available"] else 1


def _cmd_lanes(args: argparse.Namespace, ctx: Context) -> int:
    """Probe every lane and show the fallback decision for the measured states."""
    states = probe_all(ctx.lanes, args.probe_timeout)
    rows = {
        k: {
            "up": v.up,
            "model": v.model,
            "detail": v.detail or "up",
            "configured": bool(ctx.lanes[k].base),
        }
        for k, v in states.items()
    }
    fallback = fallback_decision(
        fast_up=states["fast"].up,
        deep_up=states["deep"].up,
        flash_up=states["flash"].up,
        fallback_installed=args.fallback_installed,
        policy=ctx.policy,
    )
    ctx.emit({"lanes": rows, "fallback": fallback})
    return 0


def _cmd_policy(args: argparse.Namespace, ctx: Context) -> int:
    """List, check or run a ``.alcor`` program through the front door."""
    if args.action == "list":
        ctx.emit({"programs": ctx.policy.programs()})
        return 0
    if args.action == "check":
        report = ctx.policy.check(args.program)
        ctx.emit(report)
        return 0 if report.get("ok") else 1
    envelope = ctx.policy.run(args.program, _cells(args.cell), args.expect_schema)
    ctx.emit(envelope)
    return 0 if envelope.get("status") == "decided" else 1


def _cmd_ask(args: argparse.Namespace, ctx: Context) -> int:
    """Answer a question through the gate."""
    result = ask(
        " ".join(args.text),
        config=ctx.config,
        policy=ctx.policy,
        lanes=ctx.lanes,
        receipts=ctx.receipts,
        requested=args.lane,
        endpoint=args.endpoint,
        thread=args.thread,
        use_memory=not args.no_memory,
        timeout=args.timeout,
        probe_timeout=args.probe_timeout,
    )
    if args.json or not result.get("ok"):
        ctx.emit(result)
    else:
        print(result["answer"], file=ctx.out)
        print(
            f"[{result['route']} | {result['reason']} | receipt {result['receipt_id'][:12]}]",
            file=ctx.err,
        )
    return 0 if result.get("ok") else 1


def _cmd_tool(args: argparse.Namespace, ctx: Context) -> int:
    """List the tools, or call one through the effect gate without a model."""
    registry = _tools(ctx, allow_write=True, allow_shell=True)
    if args.action == "list":
        ctx.emit({"tools": registry.names()})
        return 0
    text = Path(args.args_file).read_text(encoding="utf-8") if args.args_file else args.args
    arguments = _json_arg(text)
    try:
        text = registry.invoke(args.name, arguments, owner_enabled=args.owner_enabled)
    except ToolDenied as exc:
        ctx.emit(
            {
                "ok": False,
                "refused": True,
                "tool": exc.tool,
                "verdict": exc.verdict,
                "reason": exc.reason,
                "cells": exc.cells,
            }
        )
        return 1
    result: Any
    try:
        result = json.loads(text)
    except ValueError:
        result = text
    ctx.emit({"ok": True, "tool": args.name, "verdict": "allow", "result": result})
    return 0


def _cmd_agent(args: argparse.Namespace, ctx: Context) -> int:
    """Run the local agent against a loopback model."""
    lane = (
        ctx.lanes[args.lane]
        if args.endpoint is None
        else Lane("direct", "explicit endpoint", args.endpoint)
    )
    if not lane.base:
        variable = f"ALCOR_LANE_{lane.id.upper()}_BASE"
        raise UsageError(
            "usage", f"lane {lane.id!r} has no base URL; set {variable} or use --endpoint"
        )
    thread = args.thread
    ledger = ThreadLedger(
        ctx.config.threads_dir / f"{thread}.jsonl", thread_id=thread, clock=ctx.clock
    )
    runner = command_runner(admit=lambda cmd: _admit_probe(ctx, cmd))
    verifier = None
    if args.check:

        def verifier() -> dict[str, Any]:
            got = runner(args.check)
            return {"ok": got.get("rc") == 0, "rc": got.get("rc"), "output": got.get("out", "")}

    agent = LocalAgent(
        ledger=ledger,
        transport=OpenAICompatibleTransport(
            lane.base,
            expected_model=lane.expected_model,
            request_defaults=request_defaults(False),
            label=lane.id,
        ),
        model=args.model or lane.expected_model or "local",
        goal=Goal(args.goal) if args.goal else None,
        tools=_tools(ctx, allow_write=args.allow_write, allow_shell=args.allow_shell),
        policy=ctx.policy,
        receipts=ctx.receipts,
        stop_paths=ctx.config.stop_paths,
        owner_enabled=args.owner_enabled,
        recover_tool_errors=True,
        max_tool_rounds=args.max_rounds,
        verifier=verifier,
        timeout=args.timeout,
        turn_timeout=args.timeout * (args.max_rounds + 1),
        lane=lane.id,
    )
    result = agent.turn(" ".join(args.message))
    if args.json or not result.get("ok"):
        ctx.emit(result)
    else:
        print(result["reply"], file=ctx.out)
    return 0 if result.get("ok") else 1


def _admit_probe(ctx: Context, command: str) -> None:
    """Put even an operator-authored probe command behind the effect gate."""
    admitted = admit_tool_call(
        "shell",
        False,
        {"command": command},
        True,
        scope=ctx.config.scope,
        policy=ctx.policy,
        receipts=ctx.receipts,
    )
    if admitted["verdict"] != "allow":
        raise ToolDenied("shell", str(admitted["verdict"]), str(admitted["reason"]))


def _cmd_goal(args: argparse.Namespace, ctx: Context) -> int:
    """Create a goal, ask what to do next, and act on the decision."""
    store = GoalStore(
        ctx.config.goals_dir,
        ctx.policy,
        runner=command_runner(admit=lambda cmd: _admit_probe(ctx, cmd)),
        receipts=ctx.receipts,
        clock=ctx.clock,
    )
    try:
        if args.action == "create":
            goal = store.create(
                args.objective,
                satisfaction=args.satisfaction,
                progress=args.progress,
                budget_attempts=args.budget,
                goal_id=args.id,
            )
            ctx.emit(goal)
        elif args.action == "list":
            ctx.emit(
                {
                    "goals": [
                        {k: g[k] for k in ("id", "state", "objective", "approach")}
                        for g in store.goals()
                    ]
                }
            )
        elif args.action == "decide":
            result = store.decide(store.load(args.id))
            ctx.emit(result)
            return 0 if result["verdict"] in ("pursue", "satisfied") else 1
        elif args.action == "decompose":
            ctx.emit(store.decompose(args.id, args.step))
        elif args.action == "change-approach":
            ctx.emit(store.change_approach(args.id))
        elif args.action == "escalate":
            ctx.emit(store.escalate(args.id, args.why))
        elif args.action == "finish":
            outcome = store.finish(args.id)
            ctx.emit(outcome)
            return 0 if outcome["ok"] else 1
        else:
            ctx.emit(store.abandon(args.id, args.why))
    except (ValueError, FileNotFoundError) as exc:
        raise UsageError("usage", str(exc)) from exc
    return 0


def _cmd_memory(args: argparse.Namespace, ctx: Context) -> int:
    """Remember, recall, and stage or admit lessons."""
    memory = _memory(ctx)
    if args.action == "remember":
        result = memory.remember(" ".join(args.text), topic=args.topic, evidence=args.evidence)
        ctx.emit(result)
        return 0 if result.get("ok") else 1
    if args.action == "heard":
        ctx.emit(memory.note_heard(args.actor, " ".join(args.text)))
        return 0
    if args.action == "recall":
        ctx.emit(memory.recall(" ".join(args.text)))
        return 0
    if args.action == "propose":
        draft = (
            sys.stdin.read() if args.draft == "-" else Path(args.draft).read_text(encoding="utf-8")
        )
        result = memory.propose(draft, clock=ctx.clock())
        ctx.emit(result)
        return 0 if result.get("ok") else 1
    if args.action == "lessons":
        ctx.emit({"pending": memory.lessons()})
        return 0
    if args.action in ("admit", "reject"):
        # ``owner_confirmed`` is true only because an operator typed this command with this id.
        result = (memory.admit if args.action == "admit" else memory.reject)(
            args.id, clock=ctx.clock()
        )
        ctx.emit(result)
        return 0 if result.get("ok") else 1
    ok, reason = memory.ledger.verify_chain()
    ctx.emit({"ok": ok, "reason": reason, "entries": len(memory.ledger.entries())})
    return 0 if ok else 1


def _cmd_receipts(args: argparse.Namespace, ctx: Context) -> int:
    """Show the newest receipts, or verify the whole chain."""
    if args.action == "tail":
        ctx.emit({"receipts": ctx.receipts.tail(args.n)})
        return 0
    report = ctx.receipts.verify()
    ctx.emit(report)
    return 0 if report["ok"] else 1


def _cmd_serve(args: argparse.Namespace, ctx: Context) -> int:
    """Serve the gate over HTTP. Non-loopback binds need a token."""
    return serve(
        ServerContext(ctx.config, ctx.policy, ctx.lanes, ctx.receipts), args.host, args.port
    )


def _cmd_fake_provider(args: argparse.Namespace, ctx: Context) -> int:
    """Run a loopback provider that answers from a script, so the other commands work offline."""
    script: list[Any] = []
    if args.script:
        script = json.loads(Path(args.script).read_text(encoding="utf-8"))
    provider = FakeProvider(model=args.model, script=script, default_reply=args.reply)
    base = provider.start()
    print(base, file=ctx.out, flush=True)
    print(f"fake provider serving model {args.model!r}; stop with Ctrl-C", file=ctx.err, flush=True)
    stop = threading.Event()
    try:
        while not stop.wait(0.5):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        provider.stop()
    return 0


COMMANDS: dict[str, Callable[[argparse.Namespace, Context], int]] = {
    "doctor": _cmd_doctor,
    "lanes": _cmd_lanes,
    "policy": _cmd_policy,
    "ask": _cmd_ask,
    "tool": _cmd_tool,
    "agent": _cmd_agent,
    "goal": _cmd_goal,
    "memory": _cmd_memory,
    "receipts": _cmd_receipts,
    "serve": _cmd_serve,
    "fake-provider": _cmd_fake_provider,
}


def build_parser() -> argparse.ArgumentParser:
    """The argument parser for every command."""
    parser = _Parser(prog="alcorcli", description="The single gate between an agent and the world.")
    parser.add_argument("--home", help="state directory (default: $ALCOR_HOME or ~/.alcor)")
    parser.add_argument(
        "--workspace", help="directory effects may touch (default: the current directory)"
    )
    parser.add_argument("--lane-base", action="append", default=[], metavar="NAME=URL")
    parser.add_argument("--lane-model", action="append", default=[], metavar="NAME=MODEL")
    parser.add_argument("--probe-timeout", type=float, default=4.0)
    parser.add_argument(
        "--fallback-installed",
        action="store_true",
        help="declare that a fallback route exists (this carve-out ships only its decision)",
    )
    sub = parser.add_subparsers(dest="command", parser_class=_Parser)

    sub.add_parser("doctor", help="what is configured and what works")
    sub.add_parser("lanes", help="probe the model lanes and show the fallback decision")

    p = sub.add_parser("policy", help="list, check or run a .alcor program")
    p.add_argument("action", choices=["list", "check", "run"])
    p.add_argument("program", nargs="?", default="")
    p.add_argument("--cell", action="append", default=[], metavar="NAME=VALUE")
    p.add_argument("--expect-schema", default="")

    p = sub.add_parser("ask", help="answer a question through the gate")
    p.add_argument("text", nargs="+")
    p.add_argument("--lane", default="auto", choices=["auto", "flash", "fast", "deep"])
    p.add_argument(
        "--endpoint", help="a loopback base URL; skips lane routing, never the loopback rule"
    )
    p.add_argument("--thread")
    p.add_argument("--no-memory", action="store_true")
    p.add_argument("--timeout", type=float, default=60.0)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("tool", help="list tools, or call one through the effect gate")
    p.add_argument("action", choices=["list", "call"])
    p.add_argument("name", nargs="?", default="")
    p.add_argument("--args", default="{}", help="JSON object of arguments")
    p.add_argument("--args-file", help="read the JSON arguments from a file (easier to quote)")
    p.add_argument(
        "--owner-enabled", action="store_true", help="the operator enables owner-class effects"
    )

    p = sub.add_parser("agent", help="run the local agent against a loopback model")
    p.add_argument("message", nargs="+")
    p.add_argument("--lane", default="fast", choices=["flash", "fast", "deep"])
    p.add_argument("--endpoint")
    p.add_argument("--model")
    p.add_argument("--goal")
    p.add_argument("--thread", default="default")
    p.add_argument("--allow-write", action="store_true")
    p.add_argument(
        "--allow-shell",
        action="store_true",
        help="registers a recording stand-in, not a real shell",
    )
    p.add_argument("--owner-enabled", action="store_true")
    p.add_argument("--check", help="the task's own check; run when the model claims DONE")
    p.add_argument("--max-rounds", type=int, default=8)
    p.add_argument("--timeout", type=float, default=60.0)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("goal", help="goals with a checkable end and a measurable pulse")
    p.add_argument(
        "action",
        choices=[
            "create",
            "list",
            "decide",
            "decompose",
            "change-approach",
            "escalate",
            "finish",
            "abandon",
        ],
    )
    p.add_argument("id", nargs="?", default=None)
    p.add_argument("--objective", default="")
    p.add_argument("--satisfaction", default="")
    p.add_argument("--progress", default="")
    p.add_argument("--budget", type=int, default=40)
    p.add_argument("--step", action="append", default=[])
    p.add_argument("--why", default="")

    memory = sub.add_parser("memory", help="remember, recall, and stage lessons")
    actions = memory.add_subparsers(dest="action", required=True, parser_class=_Parser)
    p = actions.add_parser("remember", help="file an observation; evidence decides its admission")
    p.add_argument("text", nargs="+")
    p.add_argument("--topic", default="")
    p.add_argument("--evidence", default="", help="a workspace file, or the text of the check")
    p = actions.add_parser("recall", help="the rows nearest a query")
    p.add_argument("text", nargs="+")
    p = actions.add_parser("heard", help="register what someone said to the agent")
    p.add_argument("text", nargs="+")
    p.add_argument("--actor", default="unknown")
    p = actions.add_parser("propose", help="stage a drafted lesson; it is not memory yet")
    p.add_argument("--draft", default="-", help="lesson draft file, or - for stdin")
    actions.add_parser("lessons", help="the lessons waiting for the operator")
    for verb in ("admit", "reject"):
        p = actions.add_parser(verb, help=f"{verb} a staged lesson (operator only)")
        p.add_argument("id")
    actions.add_parser("verify", help="check the memory ledger's hash chain")

    p = sub.add_parser("receipts", help="show or verify the receipt chain")
    p.add_argument("action", choices=["tail", "verify"])
    p.add_argument("-n", type=int, default=10)

    p = sub.add_parser("serve", help="serve the gate over HTTP")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=0)

    p = sub.add_parser("fake-provider", help="a loopback provider that answers from a script")
    p.add_argument("--model", default="demo-model")
    p.add_argument("--reply", default=DEFAULT_REPLY)
    p.add_argument("--script", help="JSON list of replies")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    policy: PolicyHost | None = None,
    clock: Callable[[], float] = time.time,
) -> int:
    """Run one command and return its exit code.

    Args:
        argv: Arguments, without the program name. Defaults to ``sys.argv[1:]``.
        stdout: Where results go.
        stderr: Where notes and errors go.
        policy: A policy host to use instead of the default, for tests.
        clock: Epoch clock; the demo passes a fixed one so receipts are reproducible.
    """
    out, err = stdout or sys.stdout, stderr or sys.stderr
    arguments = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try:
        args = parser.parse_args(arguments)
        if not args.command:
            parser.print_help(out)
            return 0
        if args.command not in COMMANDS:
            print(f"unknown command: {args.command}", file=err)
            return UNKNOWN_COMMAND
        config = Config.load(args.home, args.workspace)
        ctx = Context(
            config=config,
            policy=policy or PolicyHost(),
            receipts=ReceiptLog(config.receipts_path, clock=clock),
            lanes=_lane_overrides(lanes_from_env(), args.lane_base, args.lane_model),
            out=out,
            err=err,
            clock=clock,
        )
        return COMMANDS[args.command](args, ctx)
    except SystemExit as exc:  # --help
        return exc.code if isinstance(exc.code, int) else 0
    except AlcorError as exc:
        print(f"alcorcli error: {exc}", file=err)
        return 2
    except (OSError, ValueError) as exc:
        print(f"alcorcli error: {type(exc).__name__}: {exc}", file=err)
        return 2
