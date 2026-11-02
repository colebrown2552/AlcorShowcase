"""Where the gate keeps its state, and which directories an effect may touch.

Two small value objects carry all configuration, so nothing in the gate reads a module-level
global or the process working directory:

* ``Scope`` answers "may an effect reach this path?". The host resolves a path once, here, and
  both the policy cells and the tool that later performs the effect use the same answer.
* ``Config`` names the files under the state directory (receipts, threads, goals, memory).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

HOME_ENV = "ALCOR_HOME"
ROOTS_ENV = "ALCOR_WRITE_ROOTS"
PROTECTED_ENV = "ALCOR_PROTECTED_INPUTS"


def split_paths(raw: str) -> list[str]:
    """Split a path list on ``os.pathsep``; newlines are accepted too.

    ``os.pathsep`` is ``;`` on Windows and ``:`` elsewhere. Splitting on ``:`` alone would cut a
    Windows drive letter off its path and leave every root unusable.
    """
    found: list[str] = []
    for line in raw.replace("\r", "\n").split("\n"):
        for item in line.split(os.pathsep):
            value = item.strip().strip('"')
            if value:
                found.append(value)
    return found


@dataclass(frozen=True)
class Scope:
    """The directories an effect may touch, and the ones it may read but never write.

    Attributes:
        workspace: Directory that relative paths are resolved against. Never the process cwd.
        roots: Resolved directories inside which effects are allowed.
        protected: Resolved directories that hold inputs. They can be read but not written.
    """

    workspace: Path
    roots: tuple[Path, ...]
    protected: tuple[Path, ...] = ()

    @classmethod
    def for_workspace(
        cls,
        workspace: Path | str,
        *,
        extra_roots: tuple[Path | str, ...] = (),
        protected: tuple[Path | str, ...] = (),
        environ: dict[str, str] | None = None,
    ) -> Scope:
        """Build a scope rooted at ``workspace``, widened by the environment.

        ``ALCOR_WRITE_ROOTS`` adds roots and ``ALCOR_PROTECTED_INPUTS`` adds protected inputs.
        """
        env = os.environ if environ is None else environ
        base = Path(workspace).expanduser().resolve()
        roots = [base, *(Path(p).expanduser().resolve() for p in extra_roots)]
        roots += [Path(p).expanduser().resolve() for p in split_paths(env.get(ROOTS_ENV, ""))]
        locked = [Path(p).expanduser().resolve() for p in protected]
        locked += [Path(p).expanduser().resolve() for p in split_paths(env.get(PROTECTED_ENV, ""))]
        unique_roots = tuple(dict.fromkeys(roots))
        return cls(workspace=base, roots=unique_roots, protected=tuple(dict.fromkeys(locked)))

    def resolve(self, raw: str | Path) -> Path:
        """Resolve ``raw`` to an absolute path, following symlinks.

        Relative paths are taken from the workspace. Resolving before comparing is what stops a
        symlink inside a root from pointing outside it.

        Raises:
            OSError: If the path cannot be resolved.
            ValueError: If the path holds a NUL byte.
        """
        candidate = Path(os.fspath(raw)).expanduser()
        if not candidate.is_absolute():
            candidate = self.workspace / candidate
        return candidate.resolve()

    def contains(self, raw: str | Path) -> bool:
        """Return True when the path resolves to a root or something below one.

        The comparison is by path component, so ``/data/root-old`` is not inside ``/data/root``.
        """
        try:
            resolved = self.resolve(raw)
        except (OSError, ValueError):
            return False
        return any(resolved.is_relative_to(root) for root in self.roots)

    def is_protected(self, raw: str | Path) -> bool:
        """Return True when the path is, or is below, a protected input directory."""
        try:
            resolved = self.resolve(raw)
        except (OSError, ValueError):
            return False
        return any(resolved.is_relative_to(locked) for locked in self.protected)

    def display(self, raw: str | Path) -> str:
        """Name a path for a receipt without leaking where the workspace lives.

        Paths inside the workspace are shown relative to it; any other path shows only its name.
        """
        try:
            resolved = self.resolve(raw)
        except (OSError, ValueError):
            return "(unresolvable)"
        if resolved.is_relative_to(self.workspace):
            return resolved.relative_to(self.workspace).as_posix() or "."
        return resolved.name


@dataclass(frozen=True)
class Config:
    """Names every file the gate keeps under its state directory.

    Attributes:
        home: State directory. ``ALCOR_HOME`` or ``~/.alcor`` unless given.
        scope: The effect scope.
    """

    home: Path
    scope: Scope

    @classmethod
    def load(cls, home: Path | str | None = None, workspace: Path | str | None = None) -> Config:
        """Resolve the state directory and the workspace from arguments or the environment."""
        chosen = home or os.environ.get(HOME_ENV) or Path.home() / ".alcor"
        return cls(
            home=Path(chosen).expanduser().resolve(),
            scope=Scope.for_workspace(workspace if workspace is not None else Path.cwd()),
        )

    @property
    def receipts_path(self) -> Path:
        """The hash-chained receipt log shared by every gate."""
        return self.home / "receipts.jsonl"

    @property
    def threads_dir(self) -> Path:
        """One append-only ledger per conversation thread."""
        return self.home / "threads"

    @property
    def goals_dir(self) -> Path:
        """One JSON file per goal."""
        return self.home / "goals"

    @property
    def memory_path(self) -> Path:
        """The hash-chained memory ledger."""
        return self.home / "memory" / "ledger.jsonl"

    @property
    def heard_path(self) -> Path:
        """Claims other parties made to the agent, kept so they are not recorded as observations."""
        return self.home / "memory" / "heard.jsonl"

    @property
    def pending_path(self) -> Path:
        """Lessons that were proposed but not yet admitted by the operator."""
        return self.home / "memory" / "pending-lessons.jsonl"

    @property
    def stop_paths(self) -> tuple[Path, ...]:
        """Files whose existence halts every turn. Only the operator creates them."""
        return (self.home / "STOP", self.scope.workspace / "STOP")
