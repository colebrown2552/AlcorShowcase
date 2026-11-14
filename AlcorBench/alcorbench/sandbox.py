"""Process and path isolation for agent tools and hidden checks.

This is containment for honest agents, not a security boundary against a
hostile one: a shell command can still read any file the user can read. What
it does guarantee is that commands start in the work directory with no
secrets from the parent environment, that a timeout kills every process the
command started, and that the file tools cannot reach outside the work
directory.
"""

from __future__ import annotations

import hashlib
import os
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

# Only these variables survive from the parent environment. Everything else,
# including API keys and tokens, is dropped.
_KEPT_VARS = ("PATH", "LANG", "LC_ALL", "TZ")


class PathEscape(ValueError):
    """Raised when a tool path resolves outside the work directory."""


@dataclass
class CommandResult:
    returncode: int | None  # None when the command was killed on timeout
    output: str  # stdout and stderr interleaved
    timed_out: bool
    wall_s: float


def new_workdir(prefix: str = "work-") -> Path:
    """Fresh <tmp>/work plus a sibling <tmp>/home, outside any task directory.

    The default name is neutral on purpose: a path naming the task or the
    harness would tell the agent where to look for the hidden check.
    """
    root = Path(tempfile.mkdtemp(prefix=prefix))
    (root / "home").mkdir()
    return root / "work"


def scrubbed_env(workdir: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Build a minimal environment so child processes never see parent secrets.

    HOME points at the sibling directory made by new_workdir, so tools that
    write dotfiles do not touch the real home or the graded work directory.
    """
    home = workdir.parent / "home"
    home.mkdir(exist_ok=True)
    env = {k: os.environ[k] for k in _KEPT_VARS if k in os.environ}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.setdefault("LANG", "C.UTF-8")
    env.update(
        HOME=str(home),
        PYTHONDONTWRITEBYTECODE="1",
        PYTHONIOENCODING="utf-8",
        TERM="dumb",
        GIT_AUTHOR_NAME="agent",
        GIT_AUTHOR_EMAIL="agent@localhost",
        GIT_COMMITTER_NAME="agent",
        GIT_COMMITTER_EMAIL="agent@localhost",
        GIT_CONFIG_NOSYSTEM="1",
    )
    env.update(extra or {})
    return env


def run_command(
    argv: list[str],
    cwd: Path,
    env: dict[str, str],
    timeout_s: float,
    max_output: int = 1_000_000,
) -> CommandResult:
    """Run argv in its own process group; on timeout kill the whole group.

    Output goes to a temporary file rather than a pipe so that a grandchild
    holding the pipe open cannot make us wait past the timeout.
    """
    start = time.monotonic()
    with tempfile.TemporaryFile() as out:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        timed_out = False
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
        # Kill the group either way: background children must not outlive the call.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        out.seek(0)
        data = out.read(max_output)
    return CommandResult(
        returncode=None if timed_out else proc.returncode,
        output=data.decode("utf-8", errors="replace"),
        timed_out=timed_out,
        wall_s=time.monotonic() - start,
    )


def resolve_inside(root: Path, path: str) -> Path:
    """Resolve a tool-supplied path and refuse anything outside root.

    resolve() follows symlinks and collapses '..', so both escape routes are
    caught by one containment test on the final path.
    """
    if not path or "\x00" in path:
        raise PathEscape(f"invalid path: {path!r}")
    base = root.resolve()
    target = (base / path).resolve()
    if target != base and base not in target.parents:
        raise PathEscape(f"path escapes the work directory: {path}")
    return target


def hash_files(root: Path, rel_paths: list[str]) -> dict[str, str]:
    """SHA-256 of each listed file; a missing file hashes to 'missing'."""
    hashes = {}
    for rel in rel_paths:
        p = root / rel
        hashes[rel] = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else "missing"
    return hashes
