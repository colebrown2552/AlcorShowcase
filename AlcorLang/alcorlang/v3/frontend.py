"""Structured AlcorLang v3 syntax: lowering to canonical v2 source.

``transpile`` is the whole frontend.  It rewrites assignments, ``PRINT``, ``INPUT``, ``IF`` and
``FOR`` into the v2 statements they stand for, lowers infix expressions to prefix and each
``.alcor.*`` directive to one embedded v1 statement.  Control flow becomes forward labels and
jumps (``IF``) or a compile-time unroll (``FOR`` with constant bounds), so the result is legal
under the halting ``default`` profile; only a ``FOR`` with a dynamic bound needs a backward jump
and therefore the authority-gated ``complete`` profile.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from .common import (
    MAX_DIRECTIVES,
    MAX_SOURCE_BYTES,
    MAX_UNROLL,
    PROGRAM_RE,
    AlcorLangV3Error,
    DirectiveState,
    Labels,
    logical_lines,
    reserved_cells,
    reserved_labels,
)
from .directives import apply_directive_semantics, directive_to_v2, parse_directives
from .expr import compile_expression, expr_to_v2, literal_int, parse_expression

_ASSIGN_RE = re.compile(r"\A(\$[a-z][a-z0-9_]{0,31})\s*=\s*(.+)\Z", re.S)
_LET_ASSIGN_RE = re.compile(r"\ALET\s+(\$[a-z][a-z0-9_]{0,31})\s*=\s*(.+)\Z", re.I | re.S)
_INPUT_RE = re.compile(r"\AINPUT\s+(\$[a-z][a-z0-9_]{0,31})\s*\Z", re.I)
_IF_RE = re.compile(r"\AIF\s+(.+)\s+THEN\s*\Z", re.I | re.S)
_FOR_HEAD_RE = re.compile(r"\AFOR\s+(\$[a-z][a-z0-9_]{0,31})\s+FROM\s+(.+)\Z", re.I | re.S)
_MARKERS = frozenset({"ALCOR 3", "ALCORLANG 3", "#!ALCOR 3"})


def _find_top_level_keyword(text: str, keyword: str) -> int:
    quoted = False
    escaped = False
    depth = 0
    i = 0
    upper = text.upper()
    while i <= len(text) - len(keyword):
        ch = text[i]
        if quoted:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                quoted = False
            i += 1
            continue
        if ch == '"':
            quoted = True
            i += 1
            continue
        if ch in "([{":
            depth += 1
            i += 1
            continue
        if ch in ")]}":
            depth -= 1
            if depth < 0:
                return -1
            i += 1
            continue
        if depth == 0 and upper.startswith(keyword, i):
            before = text[i - 1] if i else " "
            after_pos = i + len(keyword)
            after = text[after_pos] if after_pos < len(text) else " "
            if before.isspace() and after.isspace():
                return i
        i += 1
    return -1


def _parse_for_header(line: str) -> tuple[str, str, str, str] | None:
    match = _FOR_HEAD_RE.fullmatch(line)
    if not match:
        return None
    cell = match.group(1)
    rest = match.group(2).strip()
    to_pos = _find_top_level_keyword(rest, "TO")
    if to_pos < 0:
        raise AlcorLangV3Error("FOR is missing a top-level TO")
    start = rest[:to_pos].strip()
    after_to = rest[to_pos + 2 :].strip()
    step_pos = _find_top_level_keyword(after_to, "STEP")
    if step_pos >= 0:
        end = after_to[:step_pos].strip()
        step = after_to[step_pos + 4 :].strip()
    else:
        end, step = after_to, "1"
    if not start or not end or not step:
        raise AlcorLangV3Error("FOR start, end, and STEP may not be empty")
    return cell, start, end, step


def _remove_leading_marker(src: str) -> tuple[str, bool]:
    lines = src.split("\n")
    for index, raw in enumerate(lines):
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.upper() in _MARKERS:
            del lines[index]
            return "\n".join(lines), True
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        break
    return src, False


# A JSON string literal, or any other run of non-space characters.
_STRING_OR_WORD_RE = re.compile(r'"(?:\\.|[^"\\])*"|\S+')


def _rename_branch_labels(line: str, mapping: dict[str, str]) -> str:
    """Rename the label operands of ``BRANCH <expr> <then> [ELSE <other>]``.

    The line is split into string literals and bare words first, so the text ``ELSE`` or a
    label-like word inside a string in the condition is never mistaken for syntax.  Splitting
    on the raw text instead would leave a label unrenamed in an unrolled loop copy, and the
    program would be rejected with a bogus "unknown label".
    """
    tokens = list(_STRING_OR_WORD_RE.finditer(line))
    has_else = len(tokens) >= 3 and tokens[-2].group() == "ELSE"
    operand_indexes = (-1, -3) if has_else else (-1,)  # right to left, so offsets stay valid
    for index in operand_indexes:
        token = tokens[index]
        renamed = mapping.get(token.group(), token.group())
        line = line[: token.start()] + renamed + line[token.end() :]
    return line


def _clone_block(lines: Sequence[str], labels: Labels) -> list[str]:
    definitions: list[str] = []
    for line in lines:
        m = re.match(r"\ALABEL\s+([a-z][a-z0-9_]{0,31})\s*\Z", line, re.I)
        if m:
            definitions.append(m.group(1))
    mapping = {name: labels.new("v3_unroll") for name in definitions}
    out: list[str] = []
    for line in lines:
        m = re.match(r"\ALABEL\s+([a-z][a-z0-9_]{0,31})\s*\Z", line, re.I)
        if m and m.group(1) in mapping:
            out.append("LABEL " + mapping[m.group(1)])
            continue
        m = re.match(r"\AJUMP\s+([a-z][a-z0-9_]{0,31})\s*\Z", line, re.I)
        if m and m.group(1) in mapping:
            out.append("JUMP " + mapping[m.group(1)])
            continue
        if line.upper().startswith("BRANCH "):
            out.append(_rename_branch_labels(line, mapping))
            continue
        out.append(line)
    return out


def _check_lowered_directive_budget(lines: Sequence[str]) -> None:
    """Bound the actual gated attempts produced by static lowering.

    Source-level counting alone is insufficient because a constant FOR is
    expanded before v2 sees it. One directive in a 1,000-iteration loop would
    otherwise become 1,000 EFFECT instructions while appearing to consume one
    slot. Branch arms and each unrolled copy count independently.
    """
    count = sum(1 for line in lines if " schema=alcor.directive.v1 " in f" {line} ")
    if count > MAX_DIRECTIVES:
        raise AlcorLangV3Error(
            f"program lowers to {count} directive attempts; limit is {MAX_DIRECTIVES}"
        )


def _for_values(start: int, end: int, step: int) -> list[int]:
    if step == 0:
        raise AlcorLangV3Error("FOR STEP cannot be zero")
    if step > 0:
        if start > end:
            return []
        count = ((end - start) // step) + 1
    else:
        if start < end:
            return []
        count = ((start - end) // (-step)) + 1
    if count > MAX_UNROLL:
        raise AlcorLangV3Error(f"constant FOR expands to {count} iterations; limit is {MAX_UNROLL}")
    return [start + (i * step) for i in range(count)]


def _compile_block(
    lines: Sequence[str],
    index: int,
    stop: frozenset[str],
    labels: Labels,
    state: DirectiveState,
) -> tuple[list[str], int, str | None]:
    out: list[str] = []
    while index < len(lines):
        line = lines[index].strip()
        upper = line.upper()
        if upper in stop:
            return out, index, upper
        if upper in {"ELSE", "END IF", "END FOR"}:
            raise AlcorLangV3Error(f"unexpected {line!r}")

        if_match = _IF_RE.fullmatch(line)
        if if_match:
            cond = compile_expression(if_match.group(1))
            before = state.clone()
            then_state = before.clone()
            then_lines, at, term = _compile_block(
                lines, index + 1, frozenset({"ELSE", "END IF"}), labels, then_state
            )
            if term is None:
                raise AlcorLangV3Error("IF without END IF")
            else_lines: list[str] = []
            if term == "ELSE":
                else_state = before.clone()
                else_lines, at, term = _compile_block(
                    lines, at + 1, frozenset({"END IF"}), labels, else_state
                )
                if term != "END IF":
                    raise AlcorLangV3Error("ELSE without END IF")
                state.merge_intersection(then_state, else_state)
            else:
                state.merge_intersection(before, then_state)
            then_label = labels.new("v3_if_then")
            else_label = labels.new("v3_if_else")
            end_label = labels.new("v3_if_end")
            out.append(f"BRANCH {cond} {then_label} ELSE {else_label}")
            out.append(f"LABEL {then_label}")
            out.extend(then_lines)
            out.append(f"JUMP {end_label}")
            out.append(f"LABEL {else_label}")
            out.extend(else_lines)
            out.append(f"LABEL {end_label}")
            index = at + 1
            continue

        for_parts = _parse_for_header(line)
        if for_parts:
            cell, start_text, end_text, step_text = for_parts
            start_expr = parse_expression(start_text)
            end_expr = parse_expression(end_text)
            step_expr = parse_expression(step_text)
            step = literal_int(step_expr)
            if step is None:
                raise AlcorLangV3Error("FOR STEP must be an integer literal")
            if step == 0:
                raise AlcorLangV3Error("FOR STEP cannot be zero")
            before = state.clone()
            body_state = before.clone()
            body_lines, at, term = _compile_block(
                lines, index + 1, frozenset({"END FOR"}), labels, body_state
            )
            if term != "END FOR":
                raise AlcorLangV3Error("FOR without END FOR")
            start_int = literal_int(start_expr)
            end_int = literal_int(end_expr)
            if start_int is not None and end_int is not None:
                values = _for_values(start_int, end_int, step)
                # The induction cell is initialized even for an empty loop. It
                # is compiler-controlled between iterations and, after a
                # non-empty loop, holds the first value beyond the inclusive
                # bound. This exactly matches the dynamic lowering below.
                out.append(f"LET {cell} {start_int}")
                for offset, value in enumerate(values):
                    if offset:
                        out.append(f"LET {cell} {value}")
                    out.extend(_clone_block(body_lines, labels))
                if values:
                    out.append(f"LET {cell} {values[-1] + step}")
                if values:
                    state.bound = set(body_state.bound)
                    state.count = body_state.count
                else:
                    state.bound = set(before.bound)
                    state.count = before.count
            else:
                # A dynamic loop may execute zero times, so bindings made only in
                # its body are not definitely available after it.
                state.bound = set(before.bound)
                state.count = max(before.count, body_state.count)
                test_label = labels.new("v3_for_test")
                body_label = labels.new("v3_for_body")
                end_label = labels.new("v3_for_end")
                # Use an inaccessible, collision-free compiler cell for loop
                # control. A body assignment to the public induction cell
                # therefore cannot change trip count or its post-loop value.
                counter = "$" + labels.new("v3_for_counter")
                cmp_op = "LE" if step > 0 else "GE"
                out.append(f"LET {counter} {expr_to_v2(start_expr)}")
                out.append(f"LET {cell} {counter}")
                out.append(f"LABEL {test_label}")
                out.append(
                    f"BRANCH {cmp_op} {counter} {expr_to_v2(end_expr)} "
                    f"{body_label} ELSE {end_label}"
                )
                out.append(f"LABEL {body_label}")
                out.append(f"LET {cell} {counter}")
                out.extend(body_lines)
                out.append(f"LET {counter} ADD {counter} {step}")
                out.append(f"LET {cell} {counter}")
                out.append(f"JUMP {test_label}")
                out.append(f"LABEL {end_label}")
            index = at + 1
            continue

        assign = _ASSIGN_RE.fullmatch(line) or _LET_ASSIGN_RE.fullmatch(line)
        if assign:
            out.append(f"LET {assign.group(1)} {compile_expression(assign.group(2))}")
            index += 1
            continue
        if upper.startswith("PRINT "):
            out.append("EMIT " + compile_expression(line[6:].strip()))
            index += 1
            continue
        input_match = _INPUT_RE.fullmatch(line)
        if input_match:
            out.append("READ " + input_match.group(1))
            index += 1
            continue
        if line.startswith(".alcor."):
            directives = parse_directives(line)
            for directive in directives:
                apply_directive_semantics(directive, state)
                out.append(directive_to_v2(directive))
            index += 1
            continue

        # Canonical v2 remains legal inside a v3 file. The v2 parser is still
        # the final authority over this line.
        out.append(line)
        index += 1
    return out, index, None


def transpile(src: str) -> str:
    """Lower v3 source to canonical AlcorLang v2 source.

    Only a leading explicit v3 marker selects this frontend. Every unmarked
    input is returned byte-for-byte without V3 lexical or semantic inspection.
    """
    if not isinstance(src, str):
        raise TypeError("src must be str")
    # Dispatch before delimiter/comment normalization. A valid v1/v2 source may
    # contain text that resembles V3 syntax; only an explicit marker grants this
    # frontend permission to inspect or rewrite it.
    normalized = src.replace("\r\n", "\n").replace("\r", "\n")
    marked_source, had_marker = _remove_leading_marker(normalized)
    if not had_marker:
        return src
    if len(src.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise AlcorLangV3Error("source exceeds 1 MiB limit")

    lines = logical_lines(marked_source)
    if any(line.upper() in _MARKERS for line in lines):
        raise AlcorLangV3Error("the AlcorLang v3 marker must be the first meaningful line")
    if not lines:
        raise AlcorLangV3Error("v3 marker without a program")

    labels = Labels(reserved_labels(lines) | reserved_cells(lines))
    output: list[str] = []
    top_level: list[str] = []
    found_program = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if PROGRAM_RE.match(line):
            found_program = True
            if top_level:
                raise AlcorLangV3Error("top-level statements cannot be mixed with PROGRAM blocks")
            body: list[str] = []
            j = i + 1
            while j < len(lines) and lines[j].upper() != "END PROGRAM":
                body.append(lines[j])
                j += 1
            if j >= len(lines):
                raise AlcorLangV3Error("PROGRAM without END PROGRAM")
            state = DirectiveState()
            compiled, at, term = _compile_block(body, 0, frozenset(), labels, state)
            if at != len(body) or term is not None:
                raise AlcorLangV3Error("unexpected block terminator in PROGRAM")
            _check_lowered_directive_budget(compiled)
            output.append(line)
            output.extend(compiled)
            output.append("END PROGRAM")
            i = j + 1
            continue
        if found_program:
            raise AlcorLangV3Error("statement after END PROGRAM must start another PROGRAM")
        top_level.append(line)
        i += 1

    if not found_program:
        state = DirectiveState()
        compiled, at, term = _compile_block(top_level, 0, frozenset(), labels, state)
        if at != len(top_level) or term is not None:
            raise AlcorLangV3Error("unexpected top-level block terminator")
        _check_lowered_directive_budget(compiled)
        output = ["PROGRAM Program", *compiled, "END PROGRAM"]

    return "\n".join(output) + "\n"
