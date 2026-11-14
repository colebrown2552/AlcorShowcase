"""Loading, linting and staging of tasks.

A task directory holds task.json, brief.md, check.py, fixture/ and reference/.
Only fixture/ is ever copied into the agent's work directory; check.py and
reference/ stay in the task directory, which the agent is never told about.
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .sandbox import CommandResult, hash_files, run_command, scrubbed_env

CATEGORIES = (
    "bugfix", "feature", "refactor", "testwriting", "cli",
    "multifile", "data", "config", "parsing",
)
SPLITS = ("train", "holdout")
ID_RE = re.compile(r"^([a-z]+)-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$")
REQUIRED_KEYS = {
    "id": str, "title": str, "category": str, "family": str, "difficulty": int,
    "split": str, "timeout_s": int, "protected": list, "created": str, "author": str,
}
MAX_BRIEF_BYTES = 2500
MAX_FIXTURE_FILES = 8
MAX_FIXTURE_BYTES = 40_000
# Words a brief must not contain: it is a plain engineering request.
BRIEF_BANNED = re.compile(r"check\.py|alcorbench|benchmark|reference/", re.IGNORECASE)
IGNORED_NAMES = {"__pycache__", ".pytest_cache"}

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TASK_ROOT = REPO_ROOT / "tasks" / "v1"
EXAMPLE_TASK_ROOT = REPO_ROOT / "examples" / "tasks"


@dataclass(frozen=True)
class Task:
    path: Path
    meta: dict

    @property
    def id(self) -> str:
        return self.meta["id"]

    @property
    def split(self) -> str:
        return self.meta["split"]

    @property
    def category(self) -> str:
        return self.meta["category"]

    @property
    def family(self) -> str:
        return self.meta["family"]

    @property
    def protected(self) -> list[str]:
        return list(self.meta.get("protected", []))

    @property
    def timeout_s(self) -> int:
        return int(self.meta.get("timeout_s", 60))

    @property
    def brief(self) -> str:
        return (self.path / "brief.md").read_text(encoding="utf-8")

    def reference_files(self) -> dict[str, bytes]:
        """Files the reference lays over the fixture, keyed by relative path."""
        ref = self.path / "reference"
        return {
            rel: (ref / rel).read_bytes()
            for rel in _walk(ref)
            if rel != ".delete"
        }

    def reference_deletions(self) -> list[str]:
        delete = self.path / "reference" / ".delete"
        if not delete.is_file():
            return []
        lines = delete.read_text(encoding="utf-8").splitlines()
        return [ln.strip() for ln in lines if ln.strip() and not ln.startswith("#")]


def _walk(root: Path) -> list[str]:
    """Relative POSIX paths of all regular files under root, sorted."""
    if not root.is_dir():
        return []
    out = []
    for p in root.rglob("*"):
        if p.is_file() and not IGNORED_NAMES.intersection(p.relative_to(root).parts):
            out.append(p.relative_to(root).as_posix())
    return sorted(out)


def load_task(path: Path) -> Task:
    meta = json.loads((path / "task.json").read_text(encoding="utf-8"))
    return Task(path=path.resolve(), meta=meta)


def discover(roots: list[Path], split: str = "all") -> list[Task]:
    """All tasks under the given roots, optionally filtered by split, sorted by id."""
    tasks = []
    for root in roots:
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if (d / "task.json").is_file():
                tasks.append(load_task(d))
    if split != "all":
        tasks = [t for t in tasks if t.meta.get("split") == split]
    return sorted(tasks, key=lambda t: t.id)


def task_set_hash(tasks: list[Task]) -> str:
    """Content hash of every file of every task, so runs on edited tasks are not compared."""
    h = hashlib.sha256()
    for task in sorted(tasks, key=lambda t: t.id):
        for rel in _walk(task.path):
            h.update(f"{task.id}/{rel}\0".encode())
            h.update((task.path / rel).read_bytes())
            h.update(b"\0")
    return h.hexdigest()


def lint(task: Task) -> list[str]:
    """Static problems with one task (format, size and wording rules)."""
    problems = []
    meta = task.meta
    for key, typ in REQUIRED_KEYS.items():
        if not isinstance(meta.get(key), typ):
            problems.append(f"task.json: '{key}' missing or not {typ.__name__}")
    if problems:
        return problems
    m = ID_RE.match(meta["id"])
    if not m:
        problems.append("id must be <category>-<nn>-<slug>, lowercase")
    elif m.group(1) != meta["category"]:
        problems.append("id prefix does not match category")
    if meta["id"] != task.path.name:
        problems.append("id does not match the directory name")
    if meta["category"] not in CATEGORIES:
        problems.append(f"unknown category {meta['category']!r}")
    if meta["split"] not in SPLITS:
        problems.append(f"split must be one of {SPLITS}")
    if meta["difficulty"] not in (1, 2, 3):
        problems.append("difficulty must be 1, 2 or 3")
    if not 1 <= meta["timeout_s"] <= 60:
        problems.append("timeout_s must be between 1 and 60")
    for name in ("brief.md", "check.py"):
        if not (task.path / name).is_file():
            problems.append(f"missing {name}")
    if not (task.path / "reference").is_dir():
        problems.append("missing reference/")
    if (task.path / "brief.md").is_file():
        raw = (task.path / "brief.md").read_bytes()
        if len(raw) > MAX_BRIEF_BYTES:
            problems.append(f"brief.md is {len(raw)} bytes (max {MAX_BRIEF_BYTES})")
        banned = BRIEF_BANNED.search(raw.decode("utf-8", errors="replace"))
        if banned:
            problems.append(f"brief.md mentions {banned.group(0)!r}")
    fixture = _walk(task.path / "fixture")
    size = sum((task.path / "fixture" / rel).stat().st_size for rel in fixture)
    if not fixture:
        problems.append("fixture/ is empty or missing")
    if len(fixture) > MAX_FIXTURE_FILES:
        problems.append(f"fixture has {len(fixture)} files (max {MAX_FIXTURE_FILES})")
    if size > MAX_FIXTURE_BYTES:
        problems.append(f"fixture is {size} bytes (max {MAX_FIXTURE_BYTES})")
    for rel in meta["protected"]:
        if rel not in fixture:
            problems.append(f"protected path not in fixture: {rel}")
    for rel in task.reference_deletions():
        if rel not in fixture:
            problems.append(f"reference/.delete lists a path not in fixture: {rel}")
        if rel in meta["protected"]:
            problems.append(f"reference deletes a protected file: {rel}")
    for rel in task.reference_files():
        if rel in meta["protected"]:
            problems.append(f"reference overwrites a protected file: {rel}")
    if (task.path / "check.py").is_file():
        problems += lint_check_env((task.path / "check.py").read_text(encoding="utf-8"))
    return problems


SUBPROCESS_CALLS = {"run", "Popen", "call", "check_call", "check_output"}


def lint_check_env(source: str) -> list[str]:
    """A check must not hand agent code the parent environment or the task's location.

    Every subprocess call needs an explicit env=, and os.environ may only be
    read one key at a time (os.environ.get("PATH") or os.environ["PATH"]).
    """
    problems = []
    if "ALCORBENCH_TASK_DIR" in source:
        problems.append("check.py uses ALCORBENCH_TASK_DIR; find the task with __file__")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return problems + [f"check.py does not parse: {exc}"]
    allowed = set()  # os.environ nodes that are single-key reads
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get" and _is_os_environ(node.func.value)):
            allowed.add(id(node.func.value))
        elif isinstance(node, ast.Subscript) and _is_os_environ(node.value):
            allowed.add(id(node.value))
    for node in ast.walk(tree):
        if _is_os_environ(node) and id(node) not in allowed:
            problems.append(f"check.py line {node.lineno}: passes os.environ on wholesale")
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in SUBPROCESS_CALLS
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess"
                and not any(k.arg == "env" for k in node.keywords)):
            problems.append(f"check.py line {node.lineno}: subprocess call without an explicit env=")
    return problems


def _is_os_environ(node: ast.AST) -> bool:
    return (isinstance(node, ast.Attribute) and node.attr == "environ"
            and isinstance(node.value, ast.Name) and node.value.id == "os")


def lint_set(tasks: list[Task]) -> list[str]:
    """Problems that only show across tasks: duplicate ids and families split across splits."""
    problems = []
    seen: dict[str, Path] = {}
    family_split: dict[str, str] = {}
    for t in tasks:
        if t.id in seen:
            problems.append(f"duplicate id {t.id}: {seen[t.id]} and {t.path}")
        seen[t.id] = t.path
        fam, split = t.meta.get("family"), t.meta.get("split")
        if fam in family_split and family_split[fam] != split:
            problems.append(f"family {fam!r} appears in both splits")
        family_split.setdefault(fam, split)
    return problems


def stage_workdir(task: Task, workdir: Path) -> None:
    """Copy only fixture/ into workdir and commit it, so agents can use git diff."""
    shutil.copytree(
        task.path / "fixture", workdir,
        ignore=shutil.ignore_patterns(*IGNORED_NAMES),
    )
    env = scrubbed_env(workdir)
    for argv in (
        ["git", "init", "-q", "-b", "main"],
        ["git", "add", "-A"],
        ["git", "commit", "-q", "-m", "initial", "--no-gpg-sign"],
    ):
        subprocess.run(argv, cwd=workdir, env=env, check=True, capture_output=True, timeout=60)


def apply_reference(task: Task, workdir: Path) -> None:
    """Lay reference/ over the work directory and remove what .delete lists."""
    for rel, data in task.reference_files().items():
        dest = workdir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    for rel in task.reference_deletions():
        (workdir / rel).unlink(missing_ok=True)


def run_check(task: Task, workdir: Path) -> CommandResult:
    """Run the hidden check with cwd = workdir and a scrubbed environment.

    The check finds its own folder through __file__; nothing in the
    environment points at the task, so agent code it runs cannot find it either.
    """
    env = scrubbed_env(workdir)
    return run_command(
        [sys.executable, str(task.path / "check.py")],
        cwd=workdir, env=env, timeout_s=task.timeout_s,
    )


def protected_hashes(task: Task, workdir: Path) -> dict[str, str]:
    return hash_files(workdir, task.protected)
