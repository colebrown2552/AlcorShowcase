"""Read-only tools: read a file, list a directory, search by literal text.

Each tool confines itself to the scope by *resolution*, not by good manners: the path is resolved
(following symlinks) and compared with the roots, so a link inside the tree that points at a
private directory is caught as well. The gate has already checked the same path before a handler
runs; the check here is the second lock.

Reads say where to continue. A truncated listing or file that does not say so is
indistinguishable from a complete one, and an agent answers "does X exist?" from the part it saw.
"""

from __future__ import annotations

import fnmatch
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .config import Scope
from .errors import AlcorError
from .tools import ToolSpec

SKIP_DIRS = frozenset({".git", "node_modules", "__pycache__", ".venv"})
MAX_SEARCH_FILE_BYTES = 1024 * 1024


class ReadRefused(AlcorError):
    """The read was rejected before anything was opened."""


class ReadTools:
    """The read tools, bound to a scope.

    Args:
        scope: The roots a read may touch.
        max_lines: Default window for ``read_file``.
        max_entries: Entries ``list_dir`` returns before saying how many it cut.
        max_matches: Matching lines ``search_repo`` returns.
    """

    def __init__(
        self,
        scope: Scope,
        *,
        max_lines: int = 200,
        max_entries: int = 200,
        max_matches: int = 120,
    ) -> None:
        self.scope = scope
        self.max_lines = max_lines
        self.max_entries = max_entries
        self.max_matches = max_matches

    def _resolve(self, raw: object) -> Path:
        text = str(raw or "")
        if not self.scope.contains(text):
            raise ReadRefused("path-leaves-the-allowed-roots", text[:80])
        return self.scope.resolve(text)

    def read_file(self, arguments: Mapping[str, Any]) -> str:
        """Return numbered lines from a UTF-8 text file, and say where to continue."""
        path = self._resolve(arguments.get("path"))
        if not path.is_file():
            raise ReadRefused("not-a-file", str(arguments.get("path"))[:80])
        limit = int(arguments.get("max_lines") or self.max_lines)
        start = max(1, int(arguments.get("start_line") or 1))
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        window = lines[start - 1 : start - 1 + limit]
        body = "\n".join(f"{start + i:5d}  {line}" for i, line in enumerate(window))
        after = len(lines) - (start - 1 + len(window))
        if start > 1:
            body = f"... ({start - 1} earlier lines)\n" + body
        if after > 0:
            next_line = start + len(window)
            body += f"\n... ({after} more lines; call read_file again with start_line={next_line})"
        return body

    def list_dir(self, arguments: Mapping[str, Any]) -> str:
        """List a directory, directories first marked with a trailing slash."""
        path = self._resolve(arguments.get("path") or ".")
        if not path.is_dir():
            raise ReadRefused("not-a-directory", str(arguments.get("path"))[:80])
        entries = sorted(path.iterdir(), key=lambda entry: entry.name)
        rows = [f"{e.name}/" if e.is_dir() else e.name for e in entries[: self.max_entries]]
        body = "\n".join(rows) or "(empty)"
        dropped = len(entries) - len(rows)
        if dropped > 0:
            body += f"\n... ({dropped} more entries; list a subdirectory)"
        return body

    def search_repo(self, arguments: Mapping[str, Any]) -> str:
        """Find lines containing a literal string. No shell, no regular expression."""
        pattern = str(arguments.get("pattern") or "")
        if not pattern:
            raise ReadRefused("empty-pattern")
        glob = str(arguments.get("glob") or "").strip()
        root = self._resolve(arguments.get("path") or ".")
        rows: list[str] = []
        for directory, dirs, files in os.walk(root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            for name in sorted(files):
                if glob and not fnmatch.fnmatch(name, glob):
                    continue
                file = Path(directory) / name
                try:
                    if file.stat().st_size > MAX_SEARCH_FILE_BYTES:
                        continue
                    raw = file.read_bytes()
                except OSError:
                    continue
                if b"\0" in raw[:1024]:
                    continue
                shown = self.scope.display(file)
                for number, line in enumerate(raw.decode("utf-8", "replace").splitlines(), 1):
                    if pattern in line:
                        rows.append(f"{shown}:{number}:{line[:200]}")
                        if len(rows) >= self.max_matches:
                            return "\n".join(rows) + "\n... (match limit reached)"
        return "\n".join(rows) or "(no matches)"

    def specs(self) -> tuple[ToolSpec, ...]:
        """The three read tools, none of them mutating."""
        return (
            ToolSpec(
                name="read_file",
                description="Read a UTF-8 text file from the workspace, with line numbers.",
                handler=self.read_file,
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Workspace-relative path"},
                        "start_line": {"type": "integer", "description": "1-based first line"},
                        "max_lines": {"type": "integer", "description": "Default 200"},
                    },
                    "required": ["path"],
                },
            ),
            ToolSpec(
                name="list_dir",
                description="List a workspace directory.",
                handler=self.list_dir,
                parameters={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            ),
            ToolSpec(
                name="search_repo",
                description="Find lines containing a literal string in the workspace.",
                handler=self.search_repo,
                parameters={
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string"},
                        "glob": {"type": "string", "description": "File name filter, e.g. *.py"},
                    },
                    "required": ["pattern"],
                },
            ),
        )
