"""AlcorLint: read-only diagnostics for AlcorLang programs and projects.

The language implementation stays the only parser and static checker.  This module translates
its verdict into a stable diagnostic contract (``alcor.lint.v1``) and adds warnings that are
about portability and safety rather than legality.  It never runs a program, installs a gate,
writes source files, calls a model or touches the network.

Every finding has a stable rule id, a severity, a path and a 1-indexed range.  ``ok`` means no
error-severity finding; ``clean`` means no finding at all, so warnings stay non-blocking unless
the caller asks for strict mode.

Rule ids:

========================================  =========  ==========================================
rule                                      severity   meaning
========================================  =========  ==========================================
``parse/error``                           error      the canonical parser or a static check
                                                     rejected the program (cannot be disabled)
``parse/internal-error``                  error      the parser failed outside its declared
                                                     rejection type (cannot be disabled)
``source/invalid-utf8``                   error      the file is not valid UTF-8
``source/unreadable``                     error      the file could not be read
``source/trailing-whitespace``            warning    spaces or tabs after the last token
``source/tab-indentation``                warning    a leading tab
``source/missing-final-newline``          warning    no newline at end of file
``profile/unsigned-complete``             warning    a ``complete`` program with no authority is
                                                     refused by ``run()``
``profile/conformance-authority``         warning    ``authority=conformance`` is sandbox-only
``profile/unbounded-fuel``                warning    ``fuel=0`` declares an unbounded run
``vocabulary/role-check-skipped``         warning    the active table has no verb/object roles
``flow/unreachable-program``              warning    a named block no CALL can reach
``effect/in-loop``                        warning    an effect inside a loop: each iteration is
                                                     a separate gated attempt
``project/case-collision``                error      two paths differ only in case
``project/missing-include``               error      an INCLUDE names a library that is absent
``project/path-escape``                   error      a ``.alcor`` path resolves outside the root
``project/root-missing``                  error      the audit root does not exist
========================================  =========  ==========================================
"""

from __future__ import annotations

import importlib
import os
import re
from collections import Counter, deque
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

SCHEMA = "alcor.lint.v1"
SEVERITIES = ("error", "warning", "info")
_SEVERITY_ORDER = {name: index for index, name in enumerate(SEVERITIES)}

_STATEMENT_HEADS = frozenset(
    ["LET", "EMIT", "READ", "LABEL", "JUMP", "BRANCH", "LOOP", "CALL", "RETURN"]
)
_NON_EFFECT_HEADS = _STATEMENT_HEADS | frozenset(("PROGRAM", "END", "INCLUDE"))
_INCLUDE_RE = re.compile(r'^[ \t]*INCLUDE[ \t]+"([^"\n]*)"[ \t]*$')
_PROGRAM_RE = re.compile(
    r"^[ \t]*PROGRAM(?:[ \t]+([A-Za-z][A-Za-z0-9_]{0,31}))?(?:[ \t]+WITH\b.*)?[ \t]*$"
)
_LINE_RE = re.compile(r"\bline[ \t]+([0-9]+)\b", re.IGNORECASE)
_QUOTED_RE = re.compile(r"(?:got|after|token|property|profile|label)[^'\"]*['\"]([^'\"]+)['\"]")
_SKIP_DIRS = frozenset(
    (
        ".git",
        ".hg",
        ".svn",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".venv",
        "venv",
        "node_modules",
    )
)


def _language() -> Any:
    """Return the module that exposes ``parse``, ``AlcorLangError``, ``entry_props`` and ``table``.

    Callers may inject another object with the same four names; the default is this package.
    """
    return importlib.import_module(__package__ or "alcorlang")


def _rule_disabled(rule: str, disabled: frozenset[str]) -> bool:
    if rule.startswith("parse/"):
        return False
    if rule in disabled:
        return True
    return any(item.endswith("/*") and rule.startswith(item[:-1]) for item in disabled)


def _point(line: int, column: int) -> dict[str, int]:
    return {"line": max(1, int(line)), "column": max(1, int(column))}


def _diagnostic(
    rule: str,
    severity: str,
    message: str,
    *,
    path: str,
    line: int = 1,
    column: int = 1,
    end_line: int | None = None,
    end_column: int | None = None,
    hint: str | None = None,
    data: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if severity not in _SEVERITY_ORDER:
        raise ValueError(f"unknown diagnostic severity {severity!r}")
    end_line = line if end_line is None else end_line
    end_column = column + 1 if end_column is None else end_column
    result: dict[str, Any] = {
        "rule": rule,
        "severity": severity,
        "message": str(message),
        "path": path,
        "range": {"start": _point(line, column), "end": _point(end_line, end_column)},
        "line": max(1, int(line)),
        "column": max(1, int(column)),
        "hint": hint,
    }
    if data:
        result["data"] = dict(data)
    return result


def _summary(diagnostics: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    counts = Counter(str(item.get("severity", "info")) for item in diagnostics)
    return {
        "error": counts["error"],
        "warning": counts["warning"],
        "info": counts["info"],
        "total": len(diagnostics),
    }


def _sort_diagnostics(diagnostics: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[Any, ...], dict[str, Any]] = {}
    for item in diagnostics:
        start = item["range"]["start"]
        key = (
            item.get("path", ""),
            start.get("line", 1),
            start.get("column", 1),
            item.get("rule", ""),
            item.get("message", ""),
        )
        unique.setdefault(key, item)
    return sorted(
        unique.values(),
        key=lambda item: (
            item.get("path", ""),
            item["range"]["start"]["line"],
            item["range"]["start"]["column"],
            _SEVERITY_ORDER.get(item.get("severity", "info"), 99),
            item.get("rule", ""),
        ),
    )


def _report(
    scope: str,
    diagnostics: Iterable[dict[str, Any]],
    *,
    path: str | None = None,
    files_scanned: int | None = None,
    disabled_rules: Sequence[str] = (),
) -> dict[str, Any]:
    ordered = _sort_diagnostics(diagnostics)
    summary = _summary(ordered)
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "scope": scope,
        "ok": summary["error"] == 0,
        "clean": summary["total"] == 0,
        "summary": summary,
        "diagnostics": ordered,
        "disabled_rules": sorted(set(disabled_rules)),
    }
    if path is not None:
        report["path"] = path
    if files_scanned is not None:
        report["files_scanned"] = files_scanned
    return report


def _line_text(src: str, line: int) -> str:
    lines = src.splitlines()
    return lines[line - 1] if 1 <= line <= len(lines) else ""


def _first_nonspace_column(text: str) -> int:
    return len(text) - len(text.lstrip(" \t")) + 1


def _parse_location(src: str, message: str) -> tuple[int, int, int]:
    match = _LINE_RE.search(message)
    line = int(match.group(1)) if match else 1
    text = _line_text(src, line)
    column = _first_nonspace_column(text) if text else 1
    token = _QUOTED_RE.search(message)
    if token and text:
        at = text.find(token.group(1))
        if at >= 0:
            column = at + 1
            return line, column, column + max(1, len(token.group(1)))
    return line, column, column + 1


def _source_warnings(src: str, path: str, disabled: frozenset[str]) -> list[dict[str, Any]]:
    diagnostics: list[dict[str, Any]] = []
    for line_no, text in enumerate(src.splitlines(), 1):
        stripped_right = text.rstrip(" \t")
        if stripped_right != text and not _rule_disabled("source/trailing-whitespace", disabled):
            diagnostics.append(
                _diagnostic(
                    "source/trailing-whitespace",
                    "warning",
                    "trailing whitespace is not portable across formatters and editors",
                    path=path,
                    line=line_no,
                    column=len(stripped_right) + 1,
                    end_column=len(text) + 1,
                    hint="remove spaces or tabs after the final token",
                )
            )
        leading = text[: len(text) - len(text.lstrip(" \t"))]
        tab_at = leading.find("\t")
        if tab_at >= 0 and not _rule_disabled("source/tab-indentation", disabled):
            diagnostics.append(
                _diagnostic(
                    "source/tab-indentation",
                    "warning",
                    "leading tab indentation renders differently across tools",
                    path=path,
                    line=line_no,
                    column=tab_at + 1,
                    hint="indent with spaces; AlcorLang itself remains whitespace-insensitive here",
                )
            )
    if (
        src
        and not src.endswith(("\n", "\r"))
        and not _rule_disabled("source/missing-final-newline", disabled)
    ):
        line = max(1, len(src.splitlines()))
        diagnostics.append(
            _diagnostic(
                "source/missing-final-newline",
                "warning",
                "source does not end with a newline",
                path=path,
                line=line,
                column=len(_line_text(src, line)) + 1,
                hint="append one newline at end of file",
            )
        )
    return diagnostics


def _logical_statements(src: str) -> list[dict[str, Any]]:
    statements: list[dict[str, Any]] = []
    start = 0
    start_line = 1
    start_column = 1
    line = 1
    column = 1
    in_string = False
    escaped = False

    def emit(end: int) -> None:
        raw = src[start:end]
        left = len(raw) - len(raw.lstrip(" \t"))
        text = raw.strip()
        if text:
            statements.append({"text": text, "line": start_line, "column": start_column + left})

    for index, char in enumerate(src):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in (";", "\n"):
            emit(index)
            start = index + 1
            if char == "\n":
                line += 1
                column = 0
                start_line = line
                start_column = 1
            else:
                start_line = line
                start_column = column + 1
        column += 1
    emit(len(src))
    return statements


def _program_lines(src: str) -> tuple[list[tuple[int, int]], dict[str, tuple[int, int]]]:
    headers: list[tuple[int, int]] = []
    named: dict[str, tuple[int, int]] = {}
    for statement in _logical_statements(src):
        match = _PROGRAM_RE.match(statement["text"])
        if not match:
            continue
        location = (statement["line"], statement["column"])
        headers.append(location)
        name = match.group(1)
        if name and name != "WITH":
            named.setdefault(
                name, (statement["line"], statement["column"] + statement["text"].find(name))
            )
    return headers, named


def _statement_scan(src: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    loop_depth = 0
    for statement in _logical_statements(src):
        text = statement["text"]
        words = text.split()
        if len(words) >= 2 and words[0] == "END" and words[1] == "LOOP":
            loop_depth = max(0, loop_depth - 1)
            continue
        head = words[0]
        if head not in _NON_EFFECT_HEADS:
            found.append(
                {"line": statement["line"], "column": statement["column"], "loop_depth": loop_depth}
            )
        if head == "LOOP":
            loop_depth += 1
    return found


def _iter_statements(body: Iterable[Mapping[str, Any]]) -> Iterable[Mapping[str, Any]]:
    for statement in body:
        yield statement
        if statement.get("type") == "loop_while":
            yield from _iter_statements(statement.get("body", ()))


def _entry_props(ast: Mapping[str, Any], language: Any) -> Mapping[str, Any]:
    helper = getattr(language, "entry_props", None)
    if callable(helper):
        return helper(ast)
    for item in ast.get("body", ()):
        if item.get("type") == "program":
            return item.get("props", {})
    return {}


def _profile_warnings(
    ast: Mapping[str, Any], src: str, path: str, disabled: frozenset[str], language: Any
) -> list[dict[str, Any]]:
    diagnostics: list[dict[str, Any]] = []
    props = _entry_props(ast, language)
    if not props:
        return diagnostics
    headers, _ = _program_lines(src)
    line, column = headers[0] if headers else (1, 1)
    profile = props.get("profile", "default")
    authority = props.get("authority")
    fuel = props.get("fuel")
    if (
        profile == "complete"
        and not authority
        and not _rule_disabled("profile/unsigned-complete", disabled)
    ):
        diagnostics.append(
            _diagnostic(
                "profile/unsigned-complete",
                "warning",
                "complete-profile source parses but canonical run() will refuse it without "
                "authority",
                path=path,
                line=line,
                column=column,
                hint="use the default profile, or supply authority only through the host's "
                "verified path",
            )
        )
    if authority == "conformance" and not _rule_disabled("profile/conformance-authority", disabled):
        diagnostics.append(
            _diagnostic(
                "profile/conformance-authority",
                "warning",
                "authority=conformance is sandbox-only and is not portable to hosted execution",
                path=path,
                line=line,
                column=column,
                hint="keep this program in test/sandbox scope; the host supplies real authority",
            )
        )
    if str(fuel) == "0" and not _rule_disabled("profile/unbounded-fuel", disabled):
        diagnostics.append(
            _diagnostic(
                "profile/unbounded-fuel",
                "warning",
                "fuel=0 declares an unbounded complete-profile computation",
                path=path,
                line=line,
                column=column,
                hint="set a finite source limit or require the host to impose a metered ceiling",
            )
        )
    return diagnostics


def _vocabulary_warnings(
    src: str, path: str, disabled: frozenset[str], language: Any
) -> list[dict[str, Any]]:
    if _rule_disabled("vocabulary/role-check-skipped", disabled):
        return []
    statements = _statement_scan(src)
    if not statements:
        return []
    try:
        info = language.table()
    except Exception:
        return []
    if not str(info.get("role_check", "")).startswith("skipped"):
        return []
    first = statements[0]
    return [
        _diagnostic(
            "vocabulary/role-check-skipped",
            "warning",
            "the active periodic table has no role metadata, so verb/object roles were not "
            "enforced",
            path=path,
            line=first["line"],
            column=first["column"],
            hint="treat canonicalization as checked but role assignment as unverified",
            data={"table_source": info.get("source")},
        )
    ]


def _flow_warnings(
    ast: Mapping[str, Any], src: str, path: str, disabled: frozenset[str]
) -> list[dict[str, Any]]:
    if _rule_disabled("flow/unreachable-program", disabled):
        return []
    blocks = [item for item in ast.get("body", ()) if item.get("type") == "program"]
    if not blocks or blocks[0].get("name") is not None:
        return []
    _, direct_lines = _program_lines(src)
    by_name = {block.get("name"): block for block in blocks if block.get("name")}
    reachable: set[str] = set()
    queue: deque[Mapping[str, Any]] = deque((blocks[0],))
    seen_blocks: set[int] = set()
    while queue:
        block = queue.popleft()
        marker = id(block)
        if marker in seen_blocks:
            continue
        seen_blocks.add(marker)
        if block.get("name"):
            reachable.add(str(block["name"]))
        for statement in _iter_statements(block.get("body", ())):
            if statement.get("type") == "call":
                target = statement.get("program")
                if target in by_name and str(target) not in reachable:
                    queue.append(by_name[target])
    diagnostics: list[dict[str, Any]] = []
    for name, location in direct_lines.items():
        if name in reachable:
            continue
        line, column = location
        diagnostics.append(
            _diagnostic(
                "flow/unreachable-program",
                "warning",
                f"PROGRAM {name} is not reachable from the unnamed entry block",
                path=path,
                line=line,
                column=column,
                end_column=column + len(name),
                hint="CALL it from a reachable block, remove it, or move it into a library file",
                data={"program": name},
            )
        )
    return diagnostics


def _effect_warnings(src: str, path: str, disabled: frozenset[str]) -> list[dict[str, Any]]:
    if _rule_disabled("effect/in-loop", disabled):
        return []
    diagnostics: list[dict[str, Any]] = []
    for statement in _statement_scan(src):
        if statement["loop_depth"] > 0:
            diagnostics.append(
                _diagnostic(
                    "effect/in-loop",
                    "warning",
                    "embedded v1 effect is inside a loop; every iteration is a separate gated "
                    "attempt and receipt",
                    path=path,
                    line=statement["line"],
                    column=statement["column"],
                    hint="bound the loop and review per-attempt cost and authority, or move the "
                    "effect outside it",
                )
            )
    return diagnostics


def lint_source(
    src: str,
    *,
    path: str = "<memory>",
    base_dir: str | None = None,
    disabled_rules: Sequence[str] = (),
    language: Any | None = None,
) -> dict[str, Any]:
    """Lint program text without running it.

    Args:
        src: The program text.
        path: The name to show in diagnostics.
        base_dir: The include root; ``None`` means INCLUDE is not allowed (no filesystem
            authority is ever granted by the text alone).
        disabled_rules: Rule ids or family wildcards such as ``source/*`` to switch off.
            ``parse/*`` findings can never be disabled.
        language: An object with ``parse``, ``AlcorLangError``, ``entry_props`` and ``table``;
            defaults to this package.

    Returns:
        An ``alcor.lint.v1`` document report.

    Raises:
        TypeError: If ``src`` is not text.
    """
    if not isinstance(src, str):
        raise TypeError(f"src must be str, got {type(src).__name__}")
    lang = language or _language()
    disabled = frozenset(str(rule) for rule in disabled_rules)
    diagnostics = _source_warnings(src, path, disabled)
    error_type = getattr(lang, "AlcorLangError", Exception)
    try:
        ast = lang.parse(src, base_dir=base_dir)
    except error_type as exc:
        message = str(exc)
        line, column, end_column = _parse_location(src, message)
        diagnostics.append(
            _diagnostic(
                "parse/error",
                "error",
                message,
                path=path,
                line=line,
                column=column,
                end_column=end_column,
                hint="repair this canonical AlcorLang rejection before relying on warning analysis",
                data={"exception": type(exc).__name__},
            )
        )
        return _report("document", diagnostics, path=path, disabled_rules=tuple(disabled))
    except Exception as exc:
        diagnostics.append(
            _diagnostic(
                "parse/internal-error",
                "error",
                f"{type(exc).__name__}: {exc}",
                path=path,
                hint="the canonical parser failed outside its declared rejection type",
                data={"exception": type(exc).__name__},
            )
        )
        return _report("document", diagnostics, path=path, disabled_rules=tuple(disabled))
    diagnostics.extend(_profile_warnings(ast, src, path, disabled, lang))
    diagnostics.extend(_vocabulary_warnings(src, path, disabled, lang))
    diagnostics.extend(_flow_warnings(ast, src, path, disabled))
    diagnostics.extend(_effect_warnings(src, path, disabled))
    return _report("document", diagnostics, path=path, disabled_rules=tuple(disabled))


def _read_utf8(path: str, display_path: str) -> tuple[str | None, dict[str, Any] | None]:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read(), None
    except UnicodeDecodeError as exc:
        return None, _diagnostic(
            "source/invalid-utf8",
            "error",
            f"source is not valid UTF-8: {exc}",
            path=display_path,
            line=getattr(exc, "start", 0) + 1,
            hint="encode Alcor source as UTF-8",
        )
    except OSError as exc:
        return None, _diagnostic(
            "source/unreadable",
            "error",
            f"{type(exc).__name__}: {exc}",
            path=display_path,
            hint="make the source readable before auditing it",
        )


def lint_file(
    path: str,
    *,
    display_path: str | None = None,
    disabled_rules: Sequence[str] = (),
    language: Any | None = None,
) -> dict[str, Any]:
    """Lint one file.  The file's own directory is the include root.

    Args:
        path: The ``.alcor`` file.
        display_path: What to show in diagnostics instead of ``path``.
        disabled_rules: Rule ids or family wildcards to switch off.
        language: An object with the same four names as the package; defaults to this package.

    Returns:
        An ``alcor.lint.v1`` document report.
    """
    real = os.path.abspath(os.path.expanduser(path))
    shown = display_path or os.path.normpath(path)
    src, error = _read_utf8(real, shown)
    if error is not None:
        return _report("document", (error,), path=shown, disabled_rules=disabled_rules)
    assert src is not None
    return lint_source(
        src,
        path=shown,
        base_dir=os.path.dirname(real),
        disabled_rules=disabled_rules,
        language=language,
    )


def _discover(root: str) -> tuple[str, list[str]]:
    real = os.path.abspath(os.path.expanduser(root))
    if os.path.isfile(real):
        return os.path.dirname(real), [real] if real.endswith(".alcor") else []
    files: list[str] = []
    for dirpath, dirnames, names in os.walk(real, followlinks=False):
        dirnames[:] = sorted(
            name for name in dirnames if name not in _SKIP_DIRS and not name.startswith(".")
        )
        for name in sorted(names):
            if name.endswith(".alcor"):
                files.append(os.path.join(dirpath, name))
    return real, files


def _within_root(path: str, root: str) -> bool:
    try:
        return os.path.commonpath(
            (os.path.realpath(path), os.path.realpath(root))
        ) == os.path.realpath(root)
    except ValueError:
        return False


def _relative(path: str, root: str) -> str:
    return os.path.relpath(path, root).replace(os.sep, "/")


def _audit_project_rules(
    root: str, files: Sequence[str], source_by_path: Mapping[str, str], disabled: frozenset[str]
) -> list[dict[str, Any]]:
    diagnostics: list[dict[str, Any]] = []
    if not _rule_disabled("project/case-collision", disabled):
        folded: dict[str, list[str]] = {}
        for path in files:
            folded.setdefault(_relative(path, root).casefold(), []).append(_relative(path, root))
        for paths in folded.values():
            if len(paths) < 2:
                continue
            message = "case-insensitive filesystems collapse these paths: {}".format(
                ", ".join(sorted(paths))
            )
            for rel in sorted(paths):
                diagnostics.append(
                    _diagnostic(
                        "project/case-collision",
                        "error",
                        message,
                        path=rel,
                        hint="rename the files so their case-folded project paths are unique",
                        data={"collides_with": [item for item in sorted(paths) if item != rel]},
                    )
                )
    if not _rule_disabled("project/missing-include", disabled):
        for path, src in source_by_path.items():
            rel = _relative(path, root)
            for statement in _logical_statements(src):
                match = _INCLUDE_RE.match(statement["text"])
                if not match:
                    continue
                name = match.group(1)
                target = os.path.realpath(os.path.join(os.path.dirname(path), name))
                if os.path.isfile(target):
                    continue
                column = statement["column"] + statement["text"].find(name)
                diagnostics.append(
                    _diagnostic(
                        "project/missing-include",
                        "error",
                        f'INCLUDE "{name}" has no sibling library',
                        path=rel,
                        line=statement["line"],
                        column=column,
                        end_column=column + len(name),
                        hint="add the sibling .alcor library or remove the include",
                        data={"include": name},
                    )
                )
    return diagnostics


def audit(
    root: str, *, disabled_rules: Sequence[str] = (), language: Any | None = None
) -> dict[str, Any]:
    """Lint every ``.alcor`` file under a directory (or one file) and apply project rules.

    Project rules look across files: case-colliding paths, INCLUDEs with no sibling library,
    and symlinks that resolve outside the root.  Directories such as ``.git`` and
    ``node_modules`` are skipped, and symlinks are never followed during the walk.

    Args:
        root: A directory, or a single ``.alcor`` file.
        disabled_rules: Rule ids or family wildcards such as ``source/*`` to switch off.
        language: An object with the same four names as the package; defaults to this package.

    Returns:
        An ``alcor.lint.v1`` project report.
    """
    project_root, files = _discover(root)
    shown_root = os.path.normpath(root)
    disabled = frozenset(str(rule) for rule in disabled_rules)
    diagnostics: list[dict[str, Any]] = []
    source_by_path: dict[str, str] = {}
    if not os.path.exists(os.path.abspath(os.path.expanduser(root))):
        diagnostics.append(
            _diagnostic(
                "project/root-missing",
                "error",
                "audit root does not exist",
                path=shown_root,
                hint="pass a .alcor file or a directory containing Alcor programs",
            )
        )
        return _report(
            "project", diagnostics, path=shown_root, files_scanned=0, disabled_rules=tuple(disabled)
        )
    for path in files:
        rel = _relative(path, project_root)
        if not _within_root(path, project_root):
            if not _rule_disabled("project/path-escape", disabled):
                diagnostics.append(
                    _diagnostic(
                        "project/path-escape",
                        "error",
                        "audited .alcor path resolves outside the project root",
                        path=rel,
                        hint="remove the escaping symlink or audit its target explicitly",
                    )
                )
            continue
        src, error = _read_utf8(path, rel)
        if error is not None:
            diagnostics.append(error)
            continue
        assert src is not None
        source_by_path[path] = src
        diagnostics.extend(
            lint_source(
                src,
                path=rel,
                base_dir=os.path.dirname(path),
                disabled_rules=tuple(disabled),
                language=language,
            )["diagnostics"]
        )
    diagnostics.extend(_audit_project_rules(project_root, files, source_by_path, disabled))
    return _report(
        "project",
        diagnostics,
        path=shown_root,
        files_scanned=len(files),
        disabled_rules=tuple(disabled),
    )


def format_human(report: Mapping[str, Any]) -> str:
    """Render a report as ``path:line:column: severity rule: message`` lines plus a summary.

    Args:
        report: A report from ``lint_source``, ``lint_file`` or ``audit``.

    Returns:
        The text, ending in a newline.
    """
    diagnostics = report.get("diagnostics", ())
    if not diagnostics:
        count = report.get("files_scanned", 1)
        noun = "file" if count == 1 else "files"
        return f"alcorlint: clean ({count} {noun})\n"
    lines: list[str] = []
    for item in diagnostics:
        start = item["range"]["start"]
        location = f"{item.get('path', '<memory>')}:{start.get('line', 1)}:{start.get('column', 1)}"
        lines.append(
            f"{location}: {item.get('severity', 'info')} {item.get('rule', 'unknown')}: "
            f"{item.get('message', '')}"
        )
        if item.get("hint"):
            lines.append(f"  hint: {item['hint']}")
    summary = report["summary"]
    lines.append(
        f"alcorlint: {summary['error']} error(s), {summary['warning']} warning(s), "
        f"{summary['info']} info"
    )
    return "\n".join(lines) + "\n"


def exit_code(report: Mapping[str, Any], strict: bool) -> int:
    """Return the process exit status for a report.

    Errors always fail.  Warnings fail only in strict mode, so they stay advisory by default.
    """
    summary = report["summary"]
    if summary["error"]:
        return 1
    if strict and summary["warning"]:
        return 1
    return 0
