"""Detached jobs: start a long verb in the background and read its result later.

A caller with a short timeout (an agent in a tool loop, a CI step with a log limit) should not hold
a connection open for twenty minutes. ``start`` returns a job id at once. The job's output goes to
``jobs/<id>/log.txt`` and its exit code to ``jobs/<id>/exit`` when it finishes; a job without an
``exit`` file is still running (or was killed before it could write one). Foreground is the default
for every verb, because a person or a script usually wants the exit code.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import time
import traceback
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from .fsutil import utc_now

_PACKAGE_PARENT = Path(__file__).resolve().parents[1]
_JOB_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def start(
    jobs_dir: Path, kind: str, argv: Sequence[str], extra_env: Mapping[str, str] | None = None
) -> str:
    """Run ``sitekit <argv>`` detached from this process and return its job id.

    Args:
        jobs_dir: folder that holds one subfolder per job.
        kind: the verb, used as the job id's prefix.
        argv: the sitekit arguments, without ``--detach``.
        extra_env: environment for the job only. Secrets such as an approval code go here, never
            in ``argv``, because ``argv`` is written to the job record.
    """
    job_id = f"{kind}-{time.strftime('%m%dT%H%M%S', time.gmtime())}-{secrets.token_hex(2)}"
    job_dir = jobs_dir / job_id
    job_dir.mkdir(parents=True)
    record = {"kind": kind, "argv": list(argv), "started": utc_now()}
    (job_dir / "cmd.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    env = {**os.environ, **(extra_env or {})}
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(_PACKAGE_PARENT), env.get("PYTHONPATH")]))
    command = [sys.executable, "-m", "sitekit", "_jobrun", str(job_dir), *argv]
    with (job_dir / "log.txt").open("wb") as log:
        common = {
            "env": env,
            "stdin": subprocess.DEVNULL,
            "stdout": log,
            "stderr": subprocess.STDOUT,
        }
        if os.name == "nt":
            # Own process group and no console: the job outlives the terminal that started it.
            detached = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            subprocess.Popen(command, creationflags=detached, **common)
        else:
            subprocess.Popen(command, start_new_session=True, **common)
    return job_id


def record_run(job_dir: Path, run: Callable[[], int]) -> int:
    """Run a verb inside a job and write its exit code to ``exit`` however it ends."""
    code = 1
    try:
        code = run()
    except SystemExit as stop:
        if isinstance(stop.code, int):
            code = stop.code
        elif stop.code is not None:
            print(stop.code, file=sys.stderr)
    except BaseException:
        traceback.print_exc()
    finally:
        (job_dir / "exit").write_text(str(code), encoding="utf-8")
    return code


def _state(job_dir: Path) -> str:
    exit_file = job_dir / "exit"
    if not exit_file.exists():
        return "running"
    code = exit_file.read_text(encoding="utf-8").strip()
    return "ok" if code == "0" else f"exit={code}"


def running(jobs_dir: Path) -> list[str]:
    """Return the ids of jobs that have not finished."""
    if not jobs_dir.is_dir():
        return []
    return [d.name for d in sorted(jobs_dir.iterdir()) if _state(d) == "running"]


def listing(jobs_dir: Path, limit: int = 15) -> list[tuple[str, str]]:
    """Return ``(job id, state)`` for the newest ``limit`` jobs."""
    if not jobs_dir.is_dir():
        return []
    return [(d.name, _state(d)) for d in sorted(jobs_dir.iterdir())[-limit:]]


def show(jobs_dir: Path, job_id: str, lines: int = 40) -> tuple[str, str] | None:
    """Return ``(last lines of the log, state)`` for one job, or None if there is no such job.

    The id is checked against a strict pattern first, so ``../`` can never walk out of the folder.
    """
    if not _JOB_ID.fullmatch(job_id) or ".." in job_id:
        return None
    job_dir = jobs_dir / job_id
    if not job_dir.is_dir():
        return None
    log = job_dir / "log.txt"
    tail = (
        log.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
        if log.exists()
        else []
    )
    return "\n".join(tail), _state(job_dir)
