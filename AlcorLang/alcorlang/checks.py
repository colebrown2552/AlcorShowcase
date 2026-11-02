"""Static checks that run inside ``parse()``: profiles, labels, calls and the halting rule.

The halting guarantee is a compile-time property.  A ``default``-profile program may not LOOP,
jump backwards or recurse, so it is a finite DAG and provably halts.  Authority is the opposite:
a ``complete`` program without authority must still parse and is then refused by ``run()``, so
authority is a run-time check and does not appear here.
"""

from __future__ import annotations

from typing import Any

from .errors import AlcorLangError
from .syntax import INT_RE

# The properties a PROGRAM header may carry (spec section 5).
PROGRAM_PROPS = frozenset(("profile", "authority", "fuel"))

# Step cap for a complete-profile program that does not set its own (spec section 5).
# `fuel=0` means unbounded.
DEFAULT_FUEL = 10_000_000


# ---------------------------------------------------------------------------
# Static checks (spec section 5).  They run inside parse() because the halting guarantee is a
# compile-time property: corpus test m1-fail-default-loop is a *parse* test.
# ---------------------------------------------------------------------------


def _walk_stmts(body: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten a block pre-order with LOOP bodies inlined.

    Every statement gets an index in this flat list, and that index is what "backward JUMP"
    is defined against.
    """
    out: list[dict[str, Any]] = []
    for st in body:
        out.append(st)
        if st["type"] == "loop_while":
            out.extend(_walk_stmts(st["body"]))
    return out


def entry_props(module: dict[str, Any]) -> dict[str, str]:
    """Return the PROGRAM properties of the entry block (the first block).

    Args:
        module: A parsed module.

    Returns:
        The entry block's ``WITH`` properties, or ``{}`` when the module has no PROGRAM block.
    """
    for item in module["body"]:
        if item["type"] == "program":
            return item["props"]
    return {}


def profile_of(props: dict[str, str]) -> str:
    """Return the profile named by the entry properties.

    Args:
        props: The entry block's properties.

    Returns:
        ``"default"`` (the halting profile) or ``"complete"``.

    Raises:
        AlcorLangError: If the profile is anything else.
    """
    profile = props.get("profile", "default")
    if profile not in ("default", "complete"):
        raise AlcorLangError(f"unknown profile {profile!r} (want default|complete)")
    return profile


def fuel_of(props: dict[str, str]) -> int:
    """Return the step cap declared by the entry properties.

    Args:
        props: The entry block's properties.

    Returns:
        The declared ``fuel``, ``DEFAULT_FUEL`` when absent; ``0`` means unbounded.

    Raises:
        AlcorLangError: If ``fuel`` is not a non-negative integer.
    """
    raw = props.get("fuel")
    if raw is None:
        return DEFAULT_FUEL
    if not INT_RE.match(raw) or int(raw) < 0:
        raise AlcorLangError(f"fuel must be a non-negative integer, got {raw!r}")
    return int(raw)


def static_check(module: dict[str, Any]) -> dict[str, Any]:
    """Run every compile-time check on a parsed module and return it unchanged.

    Checks: property names, unique block names, the profile/fuel/authority combination, label
    existence and uniqueness, CALL targets, and the halting rule (spec section 5): under the
    ``default`` profile LOOP, backward jumps and call cycles are rejected.

    Args:
        module: The AST from ``Parser.parse_module``.

    Returns:
        The same module, so calls can be chained.

    Raises:
        AlcorLangError: On the first violation found.
    """
    blocks = [i for i in module["body"] if i["type"] == "program"]
    by_name = {}
    for idx, block in enumerate(blocks):
        for key in block["props"]:
            if key not in PROGRAM_PROPS:
                raise AlcorLangError(
                    "unknown PROGRAM property {!r} (want {})".format(
                        key, "|".join(sorted(PROGRAM_PROPS))
                    )
                )
        if block["name"]:
            if block["name"] in by_name:
                raise AlcorLangError("duplicate PROGRAM name {!r}".format(block["name"]))
            by_name[block["name"]] = idx
        elif idx != 0:
            raise AlcorLangError(
                "only the entry block may be unnamed (a nameless later block can never be CALLed)"
            )
    props = entry_props(module)
    profile = profile_of(props)
    if "fuel" in props and profile != "complete":
        raise AlcorLangError("fuel= is a complete-profile setting only (§5)")
    fuel_of(props)
    if profile == "default" and props.get("authority"):
        raise AlcorLangError("authority= is meaningless on the default profile (§5)")

    for block in blocks:
        flat = _walk_stmts(block["body"])
        labels = {}
        for pos, st in enumerate(flat):
            if st["type"] == "label":
                if st["name"] in labels:
                    raise AlcorLangError(
                        "duplicate label {!r} in program {}".format(
                            st["name"], block["name"] or "<entry>"
                        )
                    )
                labels[st["name"]] = pos
        for pos, st in enumerate(flat):
            targets = []
            if st["type"] == "jump":
                targets.append(st["name"])
            elif st["type"] == "branch":
                targets.append(st["then"])
                if st["else"]:
                    targets.append(st["else"])
            for tgt in targets:
                if tgt not in labels:
                    raise AlcorLangError(
                        "unknown label {!r} in program {}".format(tgt, block["name"] or "<entry>")
                    )
                if profile == "default" and labels[tgt] <= pos:
                    raise AlcorLangError(
                        "backward {} to label {!r} is rejected by the default profile "
                        "(§5: default programs are finite DAGs)".format(st["type"].upper(), tgt)
                    )
            if st["type"] == "loop_while" and profile == "default":
                raise AlcorLangError(
                    "LOOP is rejected by the default profile (§5): declare "
                    "PROGRAM WITH profile=complete and hold authority"
                )
            if st["type"] == "call" and st["program"] not in by_name:
                raise AlcorLangError(
                    "CALL target {!r} is not a PROGRAM in this module".format(st["program"])
                )

    if profile == "default":
        _reject_call_cycles(blocks, by_name)
    return module


def _reject_call_cycles(blocks: list[dict[str, Any]], by_name: dict[str, int]) -> None:
    """Any cycle in the static call graph breaks the DAG/halting guarantee."""
    edges = {}
    for idx, block in enumerate(blocks):
        edges[idx] = [
            by_name[s["program"]] for s in _walk_stmts(block["body"]) if s["type"] == "call"
        ]
    state = {}

    def visit(node: int, path: list[int]) -> None:
        state[node] = 1
        for nxt in edges.get(node, ()):
            if state.get(nxt) == 1:
                names = [blocks[p]["name"] or "<entry>" for p in path + [node, nxt]]
                raise AlcorLangError(
                    "recursion is rejected by the default profile (§5): call cycle {}".format(
                        " -> ".join(names)
                    )
                )
            if state.get(nxt) is None:
                visit(nxt, path + [node])
        state[node] = 2

    for node in edges:
        if state.get(node) is None:
            visit(node, [])
