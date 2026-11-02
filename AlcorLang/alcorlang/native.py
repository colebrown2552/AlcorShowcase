"""Native build driver: lower a program to C, compile it with the local C compiler, run it.

This is deliberately a driver, not another language implementation.  It compiles through the
one ALCORCORE and the one C lowering, then either hands back the C or assembly text or builds a
native executable and caches it.  The cache key is the SHA-256 of the generated C plus the
compiler's identity, and the cached binary's digest is re-checked before every run.

Native execution is narrower than the reference interpreter on purpose: only pure
``profile=default`` programs are built, until a reviewed C gate shim and a verified
complete-profile authority path exist.  A program with an EFFECT or the ``complete`` profile is
refused before any compiler is selected.
"""

from __future__ import annotations

import contextlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from .core import Core, compile_core, transpile
from .errors import AlcorLangError
from .identity import implementation_sha256
from .includes import splice_includes
from .lowering import lower_c
from .receipts import sha256_hex
from .vocabulary import table

SCHEMA = "alcor.native.compiler.v1"
INSPECT_SCHEMA = "alcor.native.inspect.v1"
CACHE_SCHEMA = "alcor.native.cache.v1"
MAX_SOURCE_BYTES = 1024 * 1024
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
DEFAULT_TIMEOUT = 5.0
MAX_TIMEOUT = 60.0
CC_FLAGS = ("-std=c99", "-O2", "-Wall", "-Wextra", "-Werror")


class AlcorCompilerError(Exception):
    """A bounded compiler/runtime refusal suitable for CLI display."""


def _canonical_json(value: Any) -> bytes:
    return (
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
        + "\n"
    ).encode("utf-8")


def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _normalize(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [_normalize(item) for item in value]
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    raise AlcorCompilerError(f"ALCORCORE contains a non-serializable {type(value).__name__}")


def _core_snapshot(core: Core) -> dict[str, Any]:
    """Canonical inspection shape; not an executable bytecode contract."""
    blocks = []
    for block in core.ordered_blocks():
        blocks.append(
            {
                "name": block.name,
                "registers": list(block.regs),
                "instructions": [_normalize(instruction) for instruction in block.code],
            }
        )
    return {
        "schema": "alcor.core.inspect.v1",
        "profile": core.profile,
        "authority": core.authority,
        "fuel": core.fuel,
        "blocks": blocks,
    }


def _source_parts(source: str, base_dir: str | None) -> tuple[str, str]:
    if not isinstance(source, str):
        raise AlcorCompilerError("source must be text")
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise AlcorCompilerError("source exceeds the 1 MiB compiler limit")
    try:
        canonical = transpile(source)
        expanded = splice_includes(canonical, base_dir)
    except AlcorLangError as exc:
        raise AlcorCompilerError(str(exc)) from None
    return canonical, expanded


def _analyze_source(source: str, base_dir: str | None) -> tuple[dict[str, Any], str]:
    """Resolve one immutable source view, then inspect and lower only that view."""
    canonical, expanded = _source_parts(source, base_dir)
    try:
        # INCLUDE files were read and pinned by _source_parts. Compiling the
        # expanded text prevents a concurrent file edit from making the report,
        # Core digest, C digest, and cache key describe different programs.
        core = compile_core(expanded)
        c_source = lower_c(expanded)
    except AlcorLangError as exc:
        raise AlcorCompilerError(str(exc)) from None

    blocks = core.ordered_blocks()
    operations: dict[str, int] = {}
    for block in blocks:
        for instruction in block.code:
            operation = instruction[0]
            operations[operation] = operations.get(operation, 0) + 1
    effect_count = operations.get("EFFECT", 0)
    reasons = []
    if core.profile != "default":
        reasons.append("profile_not_default")
    if effect_count:
        reasons.append("effect_gate_shim_unavailable")
    snapshot = _core_snapshot(core)
    table_info = table()
    report = {
        "schema": INSPECT_SCHEMA,
        "compiler_schema": SCHEMA,
        "source_sha256": sha256_hex(source.encode("utf-8")),
        "canonical_source_sha256": sha256_hex(canonical.encode("utf-8")),
        "expanded_source_sha256": sha256_hex(expanded.encode("utf-8")),
        "implementation_sha256": implementation_sha256(),
        "core_sha256": sha256_hex(_canonical_json(snapshot)),
        "c_sha256": sha256_hex(c_source.encode("utf-8")),
        "profile": core.profile,
        "authority": core.authority,
        "fuel": core.fuel,
        "block_count": len(blocks),
        "instruction_count": sum(operations.values()),
        "operations": {key: operations[key] for key in sorted(operations)},
        "effect_count": effect_count,
        "native_executable_eligible": not reasons,
        "native_executable_refusals": reasons,
        "vocabulary": {
            "source": table_info.get("source"),
            "element_count": table_info.get("element_count"),
            "role_check": table_info.get("role_check"),
        },
    }
    return report, c_source


def inspect_source(source: str, base_dir: str | None = None) -> dict[str, Any]:
    """Return a deterministic, read-only profile of one source program.

    The report holds the digests of every stage (source, canonical source, expanded source,
    Core, generated C, this implementation), block and instruction counts, the effect count, and
    whether the program is eligible for a native build, with the reasons if it is not.  Nothing
    is compiled or run.

    Args:
        source: v1, v2 or v3 source.
        base_dir: The include root.

    Returns:
        An ``alcor.native.inspect.v1`` report.

    Raises:
        AlcorCompilerError: If the source is rejected or too large.
    """
    report, _ = _analyze_source(source, base_dir)
    return report


def emit_c(source: str, base_dir: str | None = None) -> str:
    """Return the standalone C99 translation unit for a program (no compiler needed)."""
    _, c_source = _analyze_source(source, base_dir)
    return c_source


def _find_compiler() -> str:
    for name in ("cc", "clang", "gcc"):
        path = shutil.which(name)
        if path:
            return os.path.realpath(path)
    raise AlcorCompilerError("no local C compiler found (tried cc, clang, gcc)")


def _compiler_identity(compiler: str) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            [compiler, "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AlcorCompilerError(f"cannot identify C compiler: {exc}") from None
    version = proc.stdout[:8192].decode("utf-8", "replace").strip()
    try:
        compiler_sha = sha256_hex(Path(compiler).read_bytes())
    except OSError as exc:
        raise AlcorCompilerError(f"cannot hash C compiler: {exc}") from None
    return {
        "path": compiler,
        "sha256": compiler_sha,
        "version": version,
        "flags": list(CC_FLAGS),
        "system": platform.system(),
        "machine": platform.machine(),
        "release": platform.release(),
        "sdkroot": os.environ.get("SDKROOT", ""),
        "deployment_target": os.environ.get("MACOSX_DEPLOYMENT_TARGET", ""),
    }


def default_cache_dir() -> Path:
    """Return the directory built binaries are cached in.

    ``$ALCORLANG_CACHE_DIR`` wins; otherwise the platform's per-user cache location is used.
    """
    override = os.environ.get("ALCORLANG_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "Alcor" / "alcorlang-native-v1"
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "alcor" / "alcorlang-native-v1"
    root = os.environ.get("XDG_CACHE_HOME")
    if root:
        return Path(root).expanduser() / "alcor" / "alcorlang-native-v1"
    return Path.home() / ".cache" / "alcor" / "alcorlang-native-v1"


def _validate_native_eligibility(report: dict[str, Any]) -> None:
    reasons = report["native_executable_refusals"]
    if reasons:
        raise AlcorCompilerError("native executable refused: {}".format(", ".join(reasons)))


def _compile_c(compiler: str, c_source: str, output: Path, assembly: bool = False) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="alcorlang-build-", dir=str(output.parent)) as temp:
        temp_path = Path(temp)
        c_path = temp_path / "program.c"
        built_path = temp_path / ("program.s" if assembly else "program.bin")
        c_path.write_text(c_source, encoding="utf-8")
        argv = [compiler, *CC_FLAGS]
        if assembly:
            argv.append("-S")
        argv.extend(["program.c", "-o", built_path.name])
        try:
            proc = subprocess.run(
                argv,
                cwd=str(temp_path),
                capture_output=True,
                check=False,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise AlcorCompilerError(f"C compiler could not complete: {exc}") from None
        if proc.returncode != 0:
            detail = proc.stderr[-12000:].decode("utf-8", "replace").strip()
            raise AlcorCompilerError(f"C compiler failed with exit {proc.returncode}: {detail}")
        os.replace(str(built_path), str(output))


def _cache_manifest_ok(manifest_path: Path, binary_path: Path, expected: dict[str, Any]) -> bool:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest != expected:
            return False
        return (
            sha256_hex(binary_path.read_bytes()) == manifest["binary_sha256"]
            and binary_path.is_file()
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def build_native(
    source: str, base_dir: str | None = None, cache_dir: Path | None = None
) -> dict[str, Any]:
    """Build, or fetch from the cache, a native executable for a pure ``default`` program.

    The cache entry is keyed by the generated C and the compiler's identity.  An existing entry
    is reused only if its manifest matches exactly and the binary's digest still matches.

    Args:
        source: v1, v2 or v3 source.
        base_dir: The include root.
        cache_dir: Where to cache; defaults to ``default_cache_dir()``.

    Returns:
        A build record: cache key, whether it was a cache hit, the binary path and digest, the
        compiler identity and the inspection report.

    Raises:
        AlcorCompilerError: If the program is not eligible (an effect, or a ``complete``
            profile), no C compiler is found, or the compiler fails.
    """
    report, c_source = _analyze_source(source, base_dir)
    _validate_native_eligibility(report)
    compiler = _find_compiler()
    compiler_identity = _compiler_identity(compiler)
    key_payload = {
        "schema": CACHE_SCHEMA,
        "c_sha256": report["c_sha256"],
        "compiler": compiler_identity,
    }
    cache_key = sha256_hex(_canonical_json(key_payload))
    root = (cache_dir or default_cache_dir()).expanduser().resolve()
    artifact_dir = root / cache_key
    artifact_dir.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        artifact_dir.chmod(0o700)
    binary_path = artifact_dir / ("program.exe" if os.name == "nt" else "program")
    manifest_path = artifact_dir / "manifest.json"

    base_manifest = {
        "schema": CACHE_SCHEMA,
        "cache_key": cache_key,
        "c_sha256": report["c_sha256"],
        "core_sha256": report["core_sha256"],
        "expanded_source_sha256": report["expanded_source_sha256"],
        "implementation_sha256": report["implementation_sha256"],
        "compiler": compiler_identity,
    }
    cache_hit = False
    if binary_path.is_file() and manifest_path.is_file():
        try:
            binary_sha = sha256_hex(binary_path.read_bytes())
            expected = dict(base_manifest, binary_sha256=binary_sha)
            cache_hit = _cache_manifest_ok(manifest_path, binary_path, expected)
        except OSError:
            cache_hit = False
    if not cache_hit:
        # _compile_c builds in a unique temporary directory and atomically
        # replaces this path. Concurrent identical builds may duplicate work,
        # but they cannot expose a partial executable or collide on a .next name.
        _compile_c(compiler, c_source, binary_path)
        if os.name != "nt":
            mode = binary_path.stat().st_mode
            binary_path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        binary_sha = sha256_hex(binary_path.read_bytes())
        manifest = dict(base_manifest, binary_sha256=binary_sha)
        _write_bytes_atomic(manifest_path, _canonical_json(manifest))
    else:
        binary_sha = sha256_hex(binary_path.read_bytes())

    return {
        "schema": CACHE_SCHEMA,
        "cache_key": cache_key,
        "cache_hit": cache_hit,
        "binary": str(binary_path),
        "binary_sha256": binary_sha,
        "manifest": str(manifest_path),
        "compiler": compiler_identity,
        "inspection": report,
    }


def _write_bytes_atomic(path: Path, data: bytes, executable: bool = False) -> None:
    parent = path.expanduser().resolve().parent
    if not parent.is_dir():
        raise AlcorCompilerError(f"output directory does not exist: {parent}")
    fd, temporary = tempfile.mkstemp(prefix=".alcorlang-", dir=str(parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if executable and os.name != "nt":
            os.chmod(temporary, 0o755)
        os.replace(temporary, str(path.expanduser().resolve()))
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def copy_native(build: dict[str, Any], output: Path) -> Path:
    """Copy a built binary out of the cache, re-checking its digest first.

    Raises:
        AlcorCompilerError: If the cached binary changed since it was built.
    """
    source = Path(build["binary"])
    data = source.read_bytes()
    if sha256_hex(data) != build["binary_sha256"]:
        raise AlcorCompilerError("cached native binary changed before copy")
    _write_bytes_atomic(output, data, executable=True)
    return output.expanduser().resolve()


def emit_assembly(source: str, output: Path, base_dir: str | None = None) -> dict[str, Any]:
    """Compile the generated C to assembly (``cc -S``) for inspection.

    Args:
        source: v1, v2 or v3 source.
        output: Where to write the assembly; its directory must exist.
        base_dir: The include root.

    Returns:
        A record with the output path, its SHA-256 and the compiler identity.

    Raises:
        AlcorCompilerError: If no compiler is found or compilation fails.
    """
    _, c_source = _analyze_source(source, base_dir)
    compiler = _find_compiler()
    destination = output.expanduser().resolve()
    if not destination.parent.is_dir():
        raise AlcorCompilerError(f"output directory does not exist: {destination.parent}")
    _compile_c(compiler, c_source, destination, assembly=True)
    return {
        "schema": "alcor.native.assembly.v1",
        "output": str(destination),
        "sha256": sha256_hex(destination.read_bytes()),
        "compiler": _compiler_identity(compiler),
    }


def read_input(path: str | None) -> bytes:
    """Read the input a native program will receive on stdin.

    Args:
        path: A file path, ``"-"`` for this process's stdin, or ``None`` for no input.

    Returns:
        The bytes, at most 16 MiB.

    Raises:
        AlcorCompilerError: If the input is larger than 16 MiB.
    """
    if path is None:
        return b""
    if path == "-":
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    else:
        data = Path(path).expanduser().read_bytes()
    if len(data) > MAX_INPUT_BYTES:
        raise AlcorCompilerError("native input exceeds 16 MiB")
    return data


def run_native(
    build: dict[str, Any], input_data: bytes = b"", timeout: float = DEFAULT_TIMEOUT
) -> tuple[bytes, bytes, int]:
    """Run a built native program with bounded input, output and time.

    The binary's SHA-256 is re-checked against the build record first, so a cache entry that
    was modified after it was built is never executed.

    Args:
        build: The record returned by ``build_native``.
        input_data: Bytes for the program's stdin (at most 16 MiB).
        timeout: Seconds before the program is killed (greater than 0, at most 60).

    Returns:
        ``(stdout, stderr, returncode)``.

    Raises:
        AlcorCompilerError: On a digest mismatch, a timeout, oversized I/O, or a program that
            cannot be started.
    """
    if len(input_data) > MAX_INPUT_BYTES:
        raise AlcorCompilerError("native input exceeds 16 MiB")
    if timeout <= 0 or timeout > MAX_TIMEOUT:
        raise AlcorCompilerError("timeout must be greater than 0 and at most 60 seconds")
    binary = Path(build["binary"])
    if sha256_hex(binary.read_bytes()) != build["binary_sha256"]:
        raise AlcorCompilerError("cached native binary digest mismatch")
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        try:
            process = subprocess.Popen(
                [str(binary)],
                stdin=subprocess.PIPE,
                stdout=stdout_file,
                stderr=stderr_file,
                close_fds=True,
            )
            process.communicate(input=input_data, timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise AlcorCompilerError(
                f"native program exceeded {timeout:.3f}-second timeout"
            ) from None
        except OSError as exc:
            raise AlcorCompilerError(f"cannot start native program: {exc}") from None
        stdout_file.seek(0, os.SEEK_END)
        stderr_file.seek(0, os.SEEK_END)
        stdout_size = stdout_file.tell()
        stderr_size = stderr_file.tell()
        if stdout_size > MAX_OUTPUT_BYTES or stderr_size > MAX_OUTPUT_BYTES:
            raise AlcorCompilerError("native output exceeds 16 MiB")
        stdout_file.seek(0)
        stderr_file.seek(0)
        return stdout_file.read(), stderr_file.read(), process.returncode


def read_source(path: str) -> tuple[str, str | None]:
    """Read a source file (or stdin) for compilation.

    Args:
        path: A file path, or ``"-"`` for this process's stdin.

    Returns:
        ``(text, include_root)``; the include root is the file's directory, or ``None`` for
        stdin, which therefore may not INCLUDE anything.

    Raises:
        AlcorCompilerError: If the source is over 1 MiB or is not UTF-8.
    """
    if path == "-":
        raw = sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1)
        base_dir = None
    else:
        source_path = Path(path).expanduser().resolve()
        raw = source_path.read_bytes()
        base_dir = str(source_path.parent)
    if len(raw) > MAX_SOURCE_BYTES:
        raise AlcorCompilerError("source exceeds the 1 MiB compiler limit")
    try:
        return raw.decode("utf-8"), base_dir
    except UnicodeDecodeError as exc:
        raise AlcorCompilerError(f"source is not UTF-8: {exc}") from None
