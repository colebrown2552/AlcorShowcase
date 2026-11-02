"""Source to ALCORCORE: the flat instruction list every backend consumes.

``parse`` turns source into a checked AST.  ``compile_core`` then lowers each PROGRAM block to a
pc-indexed list of instructions (spec section 6.1), so the interpreter, the Python backend and
the C backend all walk one shape.  Control flow is resolved to integers here, which is why a
backward jump costs the backends nothing.
"""

from __future__ import annotations

import copy
import hashlib
from typing import Any

from .checks import entry_props, fuel_of, profile_of, static_check
from .errors import AlcorLangError
from .includes import INCLUDE_RE, splice_includes
from .syntax import Parser, lex

# A source is v3 only if its first meaningful line is one of these markers (spec v3 section 1).
_V3_MARKERS = frozenset(("ALCOR 3", "ALCORLANG 3", "#!ALCOR 3"))

# The sandbox/conformance authority (spec section 5).  Production hosts must reject it.
SANDBOX_AUTHORITY = "conformance"


def _selects_v3(src: str) -> bool:
    """Decide, cheaply and exactly, whether the v3 frontend owns this source.

    Dispatch looks only at the first meaningful line, so legacy compilation never imports the
    frontend and a v2 program that merely resembles v3 text is never rewritten.
    """
    for raw in src.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.upper() in _V3_MARKERS:
            return True
        if stripped.startswith(("#", "//")):
            continue
        return False
    return False


def transpile(src: str) -> str:
    """Lower AlcorLang v3 source to canonical v2 source.

    Sources with no explicit v3 marker are returned byte-for-byte.  That keeps one public
    parser and one ALCORCORE without guessing the dialect of older programs.

    Args:
        src: Program text.

    Returns:
        Canonical v2 (or v1) source.

    Raises:
        AlcorLangError: If ``src`` is not text, or the v3 frontend rejects it.
    """
    if not isinstance(src, str):
        raise AlcorLangError(f"source must be str, got {type(src).__name__}")
    if not _selects_v3(src):
        return src
    # Imported late so the v3 package can in turn call back into this one.
    from .v3.common import AlcorLangV3Error
    from .v3.frontend import transpile as lower_v3

    try:
        return lower_v3(src)
    except AlcorLangV3Error as exc:
        raise AlcorLangError(str(exc)) from None


def parse(src: str, base_dir: str | None = None) -> dict[str, Any]:
    """Turn v1, v2 or v3 source into the checked canonical AST (spec section 10.1).

    Args:
        src: Program text.
        base_dir: The include root.  ``None`` means the program may not INCLUDE anything.

    Returns:
        The module AST.

    Raises:
        AlcorLangError: On any lexical, grammatical or static-check failure.
    """
    canonical = transpile(src)
    return static_check(Parser(lex(splice_includes(canonical, base_dir))).parse_module())


# ---------------------------------------------------------------------------
# ALCORCORE (spec section 6.1).  A flat, pc-indexed instruction list with per-frame named
# registers: "$x" is a cell (reading an unset one traps) and "%n" is a compiler temporary.
# Instructions are tuples so all three backends walk one shape.
# ---------------------------------------------------------------------------


class Block:
    """One compiled PROGRAM block: its name, instruction list and the registers it uses."""

    __slots__ = ("name", "code", "regs")

    def __init__(self, name: str | None, code: list[tuple[Any, ...]]) -> None:
        self.name = name
        self.code = code
        self.regs = _regs_of(code)


def _regs_of(code: list[tuple[Any, ...]]) -> list[str]:
    seen = []

    def add(reg: Any) -> None:
        if isinstance(reg, str) and reg not in seen:
            seen.append(reg)

    for ins in code:
        op = ins[0]
        if op == "CONST":
            add(ins[1])
        elif op == "MOV":
            add(ins[1])
            add(ins[2])
        elif op == "BINOP":
            add(ins[2])
            add(ins[3])
            add(ins[4])
        elif op == "UNOP":
            add(ins[2])
            add(ins[3])
        elif op == "JZ":
            add(ins[1])
        elif op == "CALL":
            for _, reg in ins[2]:
                add(reg)
            add(ins[3])
        elif op == "RET":
            add(ins[1])
        elif op == "IO":
            add(ins[2])
            add(ins[3])
        elif op == "EFFECT":
            add(ins[2])
    return seen


class _BlockCompiler:
    """Compile one PROGRAM block's statements into a flat instruction list.

    Labels are recorded as they are met and every jump target is resolved to an integer pc in
    ``compile``, so forward and backward jumps are handled identically.
    """

    def __init__(self, block: dict[str, Any]) -> None:
        self.block = block
        self.code = []
        self.labels = {}
        self.tmp = 0

    def new_tmp(self) -> str:
        self.tmp += 1
        return f"%{self.tmp}"

    def emit(self, *ins: Any) -> int:
        self.code.append(tuple(ins))
        return len(self.code) - 1

    def compile(self) -> Block:
        for st in self.block["body"]:
            self.stmt(st)
        self.emit("RET", None)  # falling off the end returns int 0 (§4)
        resolved = []
        for ins in self.code:
            if ins[0] == "JMP":
                resolved.append(("JMP", self.target(ins[1])))
            elif ins[0] == "JZ":
                resolved.append(("JZ", ins[1], self.target(ins[2])))
            else:
                resolved.append(ins)
        return Block(self.block["name"], resolved)

    def target(self, tgt: Any) -> int:
        if isinstance(tgt, int):
            return tgt
        pc = self.labels.get(tgt[1])
        if pc is None:  # static_check already proved this cannot fire
            raise AlcorLangError(f"unknown label {tgt[1]!r}")
        return pc

    def expr(self, node: dict[str, Any]) -> str:
        if "int" in node or "str" in node:
            dst = self.new_tmp()
            self.emit("CONST", dst, node.get("int", node.get("str")))
            return dst
        if "cell" in node:
            return "$" + node["cell"]  # read straight from the slot; MOV would be noise
        op = node["op"]
        args = [self.expr(a) for a in node["args"]]
        dst = self.new_tmp()
        if len(args) == 1:
            self.emit("UNOP", op, dst, args[0])
        else:
            self.emit("BINOP", op, dst, args[0], args[1])
        return dst

    def stmt(self, st: dict[str, Any]) -> None:
        kind = st["type"]
        if kind == "let":
            self.emit("MOV", "$" + st["cell"], self.expr(st["expr"]))
        elif kind == "emit":
            self.emit("IO", "emit", None, self.expr(st["expr"]))
        elif kind == "read":
            self.emit("IO", "read_line", "$" + st["cell"], None)
        elif kind == "label":
            self.labels[st["name"]] = len(self.code)
        elif kind == "jump":
            self.emit("JMP", ("L", st["name"]))
        elif kind == "branch":
            src = self.expr(st["cond"])
            jz = self.emit("JZ", src, None)
            self.emit("JMP", ("L", st["then"]))
            # No ELSE => falsy falls through to the next statement.
            self.code[jz] = ("JZ", src, ("L", st["else"]) if st["else"] else len(self.code))
        elif kind == "loop_while":
            top = len(self.code)  # before the condition: it is re-evaluated
            src = self.expr(st["cond"])
            jz = self.emit("JZ", src, None)
            for inner in st["body"]:
                self.stmt(inner)
            self.emit("JMP", top)
            self.code[jz] = ("JZ", src, len(self.code))
        elif kind == "call":
            args = [(cell, self.expr(e)) for cell, e in st["args"].items()]
            self.emit("CALL", st["program"], args, ("$" + st["into"]) if st["into"] else None)
        elif kind == "return":
            self.emit("RET", self.expr(st["expr"]) if st["expr"] else None)
        elif kind == "v1":
            # §6.4/§8.1: the ONLY effectful instruction. Never inlined.
            self.emit("EFFECT", descriptor_of(st), None)
        else:
            raise AlcorLangError(f"cannot compile statement {kind!r}")


def descriptor_of(stmt: dict[str, Any]) -> dict[str, Any]:
    """Build the gate descriptor for an embedded v1 statement (spec section 6.4).

    ``value_raw`` and ``props_raw`` keep their ``$cell`` placeholders unresolved.  Spec section
    8.4 requires the gate to see the placeholder text rather than the interpolated content, so
    a receipt can never be forged by a cell value.

    Args:
        stmt: A ``v1`` AST node.

    Returns:
        The descriptor dictionary stored in the EFFECT instruction.
    """
    return {
        "verb": stmt["verb"],
        "object": stmt["object"],
        "value_raw": stmt["value"],
        "props_raw": dict(stmt["props"]),
        "tail": stmt["tail"],
    }


class Core:
    """A compiled module: entry block, call targets, profile, fuel and authority."""

    __slots__ = ("entry", "blocks", "profile", "authority", "fuel", "module")

    def __init__(self, module: dict[str, Any]) -> None:
        self.module = module
        props = entry_props(module)
        self.profile = profile_of(props)
        self.authority = props.get("authority")
        self.fuel = fuel_of(props)
        program_items = [i for i in module["body"] if i["type"] == "program"]
        if program_items:
            # SPEC GAP (§1.3 vs §1.3): the module grammar admits v1 statements
            # beside PROGRAM blocks, but "execution entry is the first block"
            # gives those statements no execution semantics. Silently dropping an
            # EFFECT would break §8.2 (every attempt is receipted), so they parse
            # (the grammar says they may) and are refused at compile-to-core time
            # — the same parses-but-prepared-not-run shape §5 uses for authority.
            if any(i["type"] == "v1" for i in module["body"]):
                raise AlcorLangError(
                    "module-level v1 statements have no execution semantics beside "
                    "a PROGRAM block (§1.3): move the effect inside a block"
                )
            items = program_items
        else:
            # A bare v1 module (§1.1 dispatch) still routes through EFFECT, so it
            # gets a synthetic entry block rather than a separate execution path.
            items = [
                {
                    "type": "program",
                    "name": None,
                    "props": {},
                    "body": [i for i in module["body"] if i["type"] == "v1"],
                }
            ]
        self.blocks = {}
        compiled = [_BlockCompiler(item).compile() for item in items]
        self.entry = compiled[0]
        for blk in compiled:
            if blk.name:
                self.blocks[blk.name] = blk

    def refused(self) -> bool:
        """Say whether this program must be refused rather than run (spec section 5).

        A ``complete`` program without the sandbox authority parses fine but is
        prepared-not-run.
        """
        if self.profile != "complete":
            return False
        return self.authority != SANDBOX_AUTHORITY

    def ordered_blocks(self) -> list[Block]:
        """Return every distinct block: the entry block first, then the rest by name."""
        blocks = [self.entry]
        seen = {id(self.entry)}
        for name in sorted(self.blocks):
            block = self.blocks[name]
            if id(block) not in seen:
                blocks.append(block)
                seen.add(id(block))
        return blocks

    def with_fuel(self, fuel: int) -> Core:
        """Return a copy of this Core with a different step cap.

        ``compile_core`` caches and shares Core objects, so a caller that wants a different
        fuel must never write to the shared one: the override would leak into every later run
        of the same source.  Compiled blocks are never mutated, so a shallow copy is enough.

        Args:
            fuel: The new step cap (``0`` means unbounded).

        Returns:
            A new Core that shares this one's blocks.
        """
        clone = copy.copy(self)
        clone.fuel = fuel
        return clone


_CORE_CACHE: dict[tuple[str, str | None], Core] = {}
_CORE_CACHE_MAX = 64


def compile_core(src: str, base_dir: str | None = None) -> Core:
    """Parse and compile, reusing an identical earlier compilation.

    Building a Core costs far more than running one for short programs, so a host that runs
    the same policy on every request would otherwise pay the parse every time.

    Only INCLUDE-free sources are cached, and that restriction is the point.  The cache key is
    the source digest, and a source that INCLUDEs depends on files the digest does not cover.
    Caching those would serve a stale program after a library changed, trading a correctness
    bug for speed.  The key also contains ``base_dir``, because identical text under a
    different include root is a different compilation.

    The returned Core may be shared.  Callers must treat it as read-only and use
    ``Core.with_fuel`` to override the step cap.

    Args:
        src: Program text.
        base_dir: The include root, or ``None`` to forbid INCLUDE.

    Returns:
        The compiled program.

    Raises:
        AlcorLangError: If the source does not parse, check or compile.
    """
    if INCLUDE_RE.search(src) is not None:
        return Core(parse(src, base_dir))
    key = (
        hashlib.sha256(src.encode("utf-8", "surrogatepass")).hexdigest(),
        None if base_dir is None else str(base_dir),
    )
    hit = _CORE_CACHE.get(key)
    if hit is not None:
        return hit
    core = Core(parse(src, base_dir))
    if len(_CORE_CACHE) >= _CORE_CACHE_MAX:
        # Bounded, and crude on purpose: this holds a handful of hot programs, not a working
        # set that deserves an eviction policy.
        _CORE_CACHE.clear()
    _CORE_CACHE[key] = core
    return core
