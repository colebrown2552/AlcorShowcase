"""A write never truncates the target before the new bytes are ready to land.

An audit found that the write tools wrote with ``write_text``, which opens the target in mode ``w``
and truncates it to zero before a byte of new content exists. A reader in another thread saw a
0-byte file on 36 of its reads during 60 writes of a 400 KB file. And when the content could not be
encoded (a lone surrogate, which ``json.loads`` accepts), the target was already truncated and the
caller was told nothing had been written to a file that was now gone.

The fix is a same-directory temporary file, fsync, and ``os.replace``: a reader sees the old file
or the new one, never an empty one.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

import pytest

from alcorcli import write_tools
from alcorcli.receipts import ReceiptLog
from alcorcli.write_tools import WriteTools


@pytest.fixture()
def tools(scope, receipts):
    return WriteTools(scope, receipts)


def _run_reader_during(path: Path, size: int, writes) -> list[int]:
    torn: list[int] = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            try:
                n = len(path.read_bytes())
            except OSError:
                # On Windows a reader can be refused for an instant while the name is swapped;
                # that is not a torn read.
                continue
            if n != size:
                torn.append(n)

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        writes()
    finally:
        stop.set()
        thread.join()
    return torn


def test_readers_never_observe_a_torn_write_file(tools, workspace):
    path = workspace / "state.json"
    big = ("x" * 99 + "\n") * 4000
    path.write_bytes(big.encode())
    size = len(path.read_bytes())
    torn = _run_reader_during(
        path, size, lambda: [tools.write_file(str(path), big) for _ in range(60)]
    )
    assert torn == [], f"readers observed {len(torn)} torn or empty states during write_file"


def test_readers_never_observe_a_torn_edit_file(tools, workspace):
    path = workspace / "code.py"
    body = ("y" * 99 + "\n") * 4000
    path.write_bytes((body + "A\n").encode())
    size = len(path.read_bytes())
    torn = _run_reader_during(
        path,
        size,
        lambda: [
            tools.edit_file(
                str(path), "A\n" if i % 2 == 0 else "B\n", "B\n" if i % 2 == 0 else "A\n"
            )
            for i in range(60)
        ],
    )
    assert torn == [], f"readers observed {len(torn)} torn or empty states during edit_file"


def test_unencodable_content_is_refused_and_the_file_survives(tools, workspace):
    keep = workspace / "keep.txt"
    keep.write_bytes(b"IMPORTANT DATA\n")
    bad = json.loads('"hi \\ud83d there"')  # a lone high surrogate json.loads accepts
    out = tools.write_file(str(keep), bad)
    assert keep.read_bytes() == b"IMPORTANT DATA\n", "the file was destroyed by a write that failed"
    assert not out.get("ok"), out
    assert out.get("status") == "refused", out
    assert "nothing was written" in str(out.get("error"))


def test_unencodable_edit_is_refused_and_the_file_survives(tools, workspace):
    keep = workspace / "keep.txt"
    keep.write_bytes(b"ANCHOR\nDATA\n")
    out = tools.edit_file(str(keep), "ANCHOR", json.loads('"\\ud83d"'))
    assert keep.read_bytes() == b"ANCHOR\nDATA\n"
    assert out.get("status") == "refused", out


def test_a_failed_write_is_receipted_as_not_ok(tools, workspace, receipts: ReceiptLog):
    keep = workspace / "keep.txt"
    keep.write_bytes(b"IMPORTANT DATA\n")
    tools.write_file(str(keep), json.loads('"\\ud83d"'))
    rows = [r["body"] for r in receipts.rows() if r["kind"] == "effect.write"]
    assert rows, "a refused write must leave a receipt row"
    assert not rows[-1].get("ok")
    assert rows[-1].get("path") == "keep.txt"


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_write_file_preserves_the_files_mode(tools, workspace):
    path = workspace / "run.sh"
    path.write_bytes(b"#!/bin/sh\n")
    os.chmod(path, 0o755)
    out = tools.write_file(str(path), "#!/bin/sh\necho hi\n")
    assert out.get("ok"), out
    assert os.stat(path).st_mode & 0o777 == 0o755


def test_new_file_is_created(tools, workspace):
    path = workspace / "deep" / "new.txt"
    out = tools.write_file(str(path), "fresh\n")
    assert out.get("ok"), out
    assert path.read_bytes() == b"fresh\n"


def test_write_path_uses_the_packages_atomic_replace():
    body = Path(write_tools.__file__).read_text(encoding="utf-8")
    assert "atomic_replace" in body
    assert "write_bytes(" not in body.replace("atomic_replace", "")
    assert sys.modules["alcorcli.fsutil"].atomic_replace is write_tools.atomic_replace
