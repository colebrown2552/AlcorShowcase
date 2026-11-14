"""Command line: python3 -m alcorbench <list|validate|run|report|compare|selfcheck>."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import tempfile
from pathlib import Path

from . import report, selfcheck
from .agents.base import Agent, RunAborted
from .agents.command import CommandAgent
from .agents.noop import NoopAgent
from .agents.reference import ReferenceAgent
from .agents.scripted import ScriptedAgent
from .agents.toolloop import ToolLoopAgent, ToolLoopConfig
from .config import ConfigError, resolve
from .runner import resume_suite, run_suite, validate
from .tasks import DEFAULT_TASK_ROOT, REPO_ROOT, discover, load_task

AGENTS = ("noop", "reference", "toolloop", "command", "scripted")
MODEL_AGENTS = ("toolloop", "command")  # the only agents whose runs are results
RESULTS_DIR = REPO_ROOT / "results"
DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1"


def build_agents(name: str, config: dict, lanes: list[str], options: dict) -> list[Agent]:
    """One agent per lane. Only toolloop has lanes; the others run a single worker.

    Shared by new runs (options from flags) and --resume (options from the manifest).
    """
    if name == "toolloop":
        return [ToolLoopAgent(ToolLoopConfig(model=lane, agent_config=config, **options))
                for lane in lanes]
    if name == "command":
        return [CommandAgent(**options)]
    return [{"noop": NoopAgent, "reference": ReferenceAgent, "scripted": ScriptedAgent}[name]()]


def agent_config(args: argparse.Namespace) -> dict:
    """configs/default.json, then --config, then the flags that were given."""
    overrides = {
        "temperature": args.temperature, "max_tokens": args.max_tokens,
        "max_turns": args.max_turns, "max_tool_calls": args.max_tool_calls,
        "command_timeout_s": args.command_timeout, "wall_time_s": args.wall_s,
    }
    if args.extra_body:
        try:
            overrides["extra_body"] = json.loads(args.extra_body)
        except json.JSONDecodeError as exc:
            sys.exit(f"--extra-body is not valid JSON: {exc}")
    if args.system_prompt_file:
        overrides["system_prompt"] = Path(args.system_prompt_file).read_text(encoding="utf-8")
    try:
        return resolve(Path(args.config) if args.config else None, overrides)
    except ConfigError as exc:
        sys.exit(str(exc))


def agents_from_args(args: argparse.Namespace, config: dict) -> list[Agent]:
    lanes = [m.strip() for m in (args.model or "").split(",") if m.strip()]
    if len(set(lanes)) != len(lanes):
        sys.exit("--model lists a model id twice; each lane allows one request in flight")
    if args.agent == "toolloop":
        if not lanes:
            sys.exit("--agent toolloop needs --model (one id, or several separated by commas)")
        options = {"base_url": args.base_url or DEFAULT_BASE_URL, "api_key_env": args.api_key_env,
                   "retries": args.retries}
        return build_agents("toolloop", config, lanes, options)
    if args.agent == "command":
        if not args.command or "{prompt_file}" not in args.command:
            sys.exit("--agent command needs --command TEMPLATE containing {prompt_file}")
        return build_agents("command", config, [], {"template": args.command,
                                                    "pass_env": args.pass_env})
    return build_agents(args.agent, config, [], {})


def _roots(args: argparse.Namespace) -> list[Path]:
    return [Path(p) for p in args.tasks] if args.tasks else [DEFAULT_TASK_ROOT]


def cmd_list(args: argparse.Namespace) -> int:
    for t in discover(_roots(args), args.split):
        print(f"{t.id:44s} {t.split:8s} {t.category:12s} {t.family:24s} d{t.meta['difficulty']}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    tasks = ([load_task(Path(d)) for d in args.task_dirs] if args.task_dirs
             else discover(_roots(args)))
    if not tasks:
        print("no tasks found")
        return 1
    problems = validate(tasks)
    bad = 0
    for task_id, issues in problems.items():
        if task_id != "*":
            print(f"{'ok  ' if not issues else 'FAIL'} {task_id}")
        for issue in issues:
            bad += 1
            print(f"     - {issue}")
    print(f"{len(tasks)} task(s), {bad} problem(s)")
    return 1 if bad else 0


def cmd_run(args: argparse.Namespace) -> int:
    if args.resume:
        return cmd_resume(args)
    if not args.agent:
        sys.exit("run needs --agent (or --resume RUN_DIR)")
    tasks = discover(_roots(args), args.split)
    if args.task:
        tasks = [t for t in tasks if t.id in set(args.task)]
    if not tasks:
        print("no tasks selected")
        return 1
    if (args.agent in MODEL_AGENTS and any(t.split == "holdout" for t in tasks)
            and not args.confirm_holdout):
        sys.exit("This run includes holdout tasks. Holdout only confirms a change that already"
                 " won on train, and every holdout run goes in results/HOLDOUT-LOG.md."
                 " Pass --confirm-holdout to proceed.")
    if args.out:
        out = Path(args.out)
    elif args.agent in MODEL_AGENTS:
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
        slug = re.sub(r"[^a-zA-Z0-9.]+", "-", args.model or "cmd").strip("-")
        out = RESULTS_DIR / f"{stamp}-{args.agent}-{slug}"
    else:
        out = Path(tempfile.mkdtemp(prefix=f"alcorbench-{args.agent}-"))
    if args.agent not in MODEL_AGENTS and out.resolve().is_relative_to(RESULTS_DIR.resolve()):
        sys.exit("results/ holds model runs only; write demo and oracle runs elsewhere")
    config = agent_config(args)
    agents = agents_from_args(args, config)
    print(f"running {len(tasks)} task(s) x {args.trials} trial(s) with {args.agent}"
          f" on {len(agents)} lane(s) -> {out}")
    try:
        run_suite(agents, tasks, args.trials, config, out, seed=args.seed, split=args.split,
                  demo=args.agent == "scripted",
                  infra_passes=2 if args.infra_passes is None else args.infra_passes,
                  infra_backoff_s=30.0 if args.infra_backoff is None else args.infra_backoff)
    except FileExistsError as exc:
        sys.exit(str(exc))
    except RunAborted as exc:
        sys.exit(f"run aborted: {exc}\nFinished trials are kept; fix the cause and use --resume.")
    print(report.render(*report.load_run(out)))
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    """Fill in missing and infra-failed trials of a saved run, with its own settings."""
    out = Path(args.resume)
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    roots = [REPO_ROOT / r for r in manifest["task_roots"]]  # absolute roots stay absolute
    by_id = {t.id: t for t in discover(roots)}
    missing = [tid for tid in manifest["task_ids"] if tid not in by_id]
    if missing:
        sys.exit(f"cannot resume: task(s) no longer found: {missing}")
    options = dict(manifest["agent_options"])
    if manifest["agent"] == "toolloop":
        if not args.base_url:
            sys.exit(f"resuming a toolloop run needs --base-url (the manifest keeps only"
                     f" {options['base_url']})")
        options["base_url"] = args.base_url
    agents = build_agents(manifest["agent"], manifest["config"], manifest["lanes"], options)
    print(f"resuming {out} with {manifest['agent']} on {len(agents)} lane(s)")
    try:
        resume_suite(agents, [by_id[tid] for tid in manifest["task_ids"]], out,
                     overrides={"infra_passes": args.infra_passes,
                                "infra_backoff_s": args.infra_backoff})
    except ValueError as exc:
        sys.exit(f"cannot resume: {exc}")
    except RunAborted as exc:
        sys.exit(f"run aborted: {exc}")
    print(report.render(*report.load_run(out)))
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    print(report.render(*report.load_run(Path(args.run_dir))))
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    a, b = Path(args.run_a), Path(args.run_b)
    try:
        print(report.render_compare(report.load_run(a), report.load_run(b), (a.name, b.name)))
    except ValueError as exc:
        sys.exit(f"cannot compare: {exc}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="alcorbench", description=__doc__)
    sub = p.add_subparsers(dest="command_name", required=True)

    def with_tasks(sp: argparse.ArgumentParser) -> argparse.ArgumentParser:
        sp.add_argument("--tasks", action="append", metavar="DIR",
                        help="task root (repeatable; default tasks/v1)")
        return sp

    sp = with_tasks(sub.add_parser("list", help="list tasks"))
    sp.add_argument("--split", default="all", choices=("train", "holdout", "all"))
    sp.set_defaults(func=cmd_list)

    sp = with_tasks(sub.add_parser("validate", help="lint tasks; noop must fail, reference pass"))
    sp.add_argument("task_dirs", nargs="*", metavar="TASK_DIR")
    sp.set_defaults(func=cmd_validate)

    sp = with_tasks(sub.add_parser("run", help="run an agent over tasks"))
    sp.add_argument("--agent", choices=AGENTS)
    sp.add_argument("--resume", metavar="RUN_DIR",
                    help="fill in missing or infra-failed trials of a saved run, using its"
                         " manifest (other flags except --infra-* and --base-url are ignored)")
    sp.add_argument("--split", default="train", choices=("train", "holdout", "all"))
    sp.add_argument("--task", action="append", metavar="ID", help="only these task ids")
    sp.add_argument("--trials", type=int, default=3)
    sp.add_argument("--seed", type=int, default=0,
                    help="run seed: per-trial seeds and the bootstrap derive from it")
    sp.add_argument("--out", help="run directory (default: results/<stamp>-... for model agents)")
    sp.add_argument("--confirm-holdout", action="store_true")
    sp.add_argument("--infra-passes", type=int, default=None,
                    help="extra passes over infra-failed trials at the end (default 2)")
    sp.add_argument("--infra-backoff", type=float, default=None,
                    help="seconds before the first extra pass, doubling after (default 30)")
    g = sp.add_argument_group("agent config (override configs/default.json and --config)")
    g.add_argument("--config", metavar="FILE", help="JSON agent config")
    g.add_argument("--max-turns", type=int)
    g.add_argument("--max-tool-calls", type=int)
    g.add_argument("--wall-s", type=float, help="per-trial agent time limit")
    g.add_argument("--command-timeout", type=float, help="per shell command")
    g.add_argument("--temperature", type=float)
    g.add_argument("--max-tokens", type=int)
    g.add_argument("--system-prompt-file")
    g.add_argument("--extra-body", help='JSON merged into each request, e.g. \'{"top_p": 0.9}\'')
    g = sp.add_argument_group("toolloop endpoint")
    g.add_argument("--base-url", help=f"default {DEFAULT_BASE_URL}; required with --resume"
                   " of a toolloop run, since the manifest keeps no host name")
    g.add_argument("--model", default="",
                   help="model id; several ids separated by commas run one lane each")
    g.add_argument("--api-key-env", default="OPENAI_API_KEY",
                   help="name of the variable holding the API key (never the key itself)")
    g.add_argument("--retries", type=int, default=4, help="on 429/502/503/504 or no connection")
    g = sp.add_argument_group("command")
    g.add_argument("--command", help="template with {prompt_file}, {workdir}, {usage_file}")
    g.add_argument("--pass-env", action="append", default=[], metavar="NAME",
                   help="environment variable to pass through to the command (repeatable)")
    sp.set_defaults(func=cmd_run)

    sp = sub.add_parser("report", help="markdown report of a run")
    sp.add_argument("run_dir")
    sp.set_defaults(func=cmd_report)

    sp = sub.add_parser("compare", help="paired comparison of two runs")
    sp.add_argument("run_a")
    sp.add_argument("run_b")
    sp.set_defaults(func=cmd_compare)

    sp = sub.add_parser("selfcheck", help="acceptance: stats, sandbox, tasks, scripted demo")
    sp.set_defaults(func=lambda a: selfcheck.main())
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
