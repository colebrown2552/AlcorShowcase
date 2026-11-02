"""The write tools touch only the bytes they were asked to touch, and the proof hashes the file.

An audit found that ``edit_file`` read with ``errors="replace"`` and wrote back with ``write_text``,
so every CRLF became LF on the way in and every byte that was not valid UTF-8 became U+FFFD. The
read-back proof used the same translating call, so it certified both corruptions, and it reported a
byte-perfect CRLF write as "does not match" with a hash that matched no file on disk.

The fix is that all text I/O goes through bytes: decode with surrogateescape, encode with
surrogateescape, hash the raw bytes. These tests assert byte identity, not just ``ok=True``.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from alcorcli import write_tools
from alcorcli.write_tools import WriteTools


@pytest.fixture()
def tools(scope, receipts):
    return WriteTools(scope, receipts)


def test_edit_preserves_every_crlf(tools, workspace):
    f = workspace / "crlf.py"
    f.write_bytes(b"import os\r\nX = 1\r\nY = 2\r\n")
    out = tools.edit_file(str(f), "X = 1", "X = 9")
    assert out.get("ok"), out
    assert f.read_bytes() == b"import os\r\nX = 9\r\nY = 2\r\n"


def test_one_value_edit_on_a_crlf_file_changes_only_that_value(tools, workspace):
    lines = [f"{i} \r\n".encode() for i in range(10315)] + [b"10316 \r\n"]
    lines += [f"{i} \r\n".encode() for i in range(3000)]
    f = workspace / "save_slot"
    f.write_bytes(b"HEADER \r\n" + b"".join(lines))
    before = f.read_bytes()
    out = tools.edit_file(str(f), "\r\n10316 \r\n", "\r\n17 \r\n")
    assert out.get("ok"), f"a CRLF anchor cannot match: {out.get('error')!r}"
    after = f.read_bytes()
    assert after == before.replace(b"\r\n10316 \r\n", b"\r\n17 \r\n", 1)
    assert after.count(b"\r") == before.count(b"\r")


def test_a_crlf_anchor_can_match(tools, workspace):
    f = workspace / "a.txt"
    f.write_bytes(b"one\r\nroom_a \r\ntwo\r\n")
    out = tools.edit_file(str(f), "\r\nroom_a \r\n", "\r\nroom_b \r\n")
    assert out.get("ok"), out
    assert f.read_bytes() == b"one\r\nroom_b \r\ntwo\r\n"


def test_edit_leaves_a_latin1_byte_alone(tools, workspace):
    g = workspace / "latin.txt"
    g.write_bytes(b"caf\xe9\nANCHOR\n")
    out = tools.edit_file(str(g), "ANCHOR", "DONE")
    assert out.get("ok"), out
    assert g.read_bytes() == b"caf\xe9\nDONE\n"


def test_edit_round_trips_bom_nul_lone_cr_and_no_final_newline(tools, workspace):
    raw = b"\xef\xbb\xbfhead\x00\rmid\r\nANCHOR tail"
    g = workspace / "odd.bin"
    g.write_bytes(raw)
    out = tools.edit_file(str(g), "ANCHOR", "B")
    assert out.get("ok"), out
    assert g.read_bytes() == raw.replace(b"ANCHOR", b"B", 1)


def test_crlf_write_is_reported_ok(tools, workspace):
    h = workspace / "save.txt"
    content = "line1\r\nline2\r\n"
    out = tools.write_file(str(h), content)
    assert h.read_bytes() == content.encode()
    assert out.get("ok") is True, (
        f"write_file reported failure for exactly the right bytes: {out!r}"
    )


def test_crlf_append_is_reported_ok(tools, workspace):
    h = workspace / "save.txt"
    h.write_bytes(b"a\r\n")
    out = tools.write_file(str(h), "b\r\n", append=True)
    assert out.get("ok"), out
    assert h.read_bytes() == b"a\r\nb\r\n"


def test_receipted_sha256_and_size_are_the_files(tools, workspace):
    p = workspace / "save"
    content = "HEADER \r\n1 \r\n0 \r\nroom_a \r\n"
    r = tools.write_file(str(p), content)
    assert p.read_bytes() == content.encode("utf-8")
    assert r.get("ok"), r
    assert r["sha256"] == hashlib.sha256(p.read_bytes()).hexdigest()
    assert r["bytes_on_disk"] == p.stat().st_size


def test_receipt_before_and_after_agree_on_an_identical_rewrite(tools, workspace, receipts):
    p = workspace / "same.txt"
    content = "x \r\ny \r\n"
    p.write_bytes(content.encode())
    r = tools.write_file(str(p), content)
    assert r.get("ok"), r
    row = [x["body"] for x in receipts.rows() if x["kind"] == "effect.write"][-1]
    assert row["sha256_before"] == row["sha256_after"], row
    assert row["sha256_after"] == hashlib.sha256(p.read_bytes()).hexdigest()


def test_edit_sha256_is_the_files_sha256_for_a_latin1_file(tools, workspace):
    g = workspace / "latin.txt"
    g.write_bytes(b"caf\xe9\nANCHOR\n")
    out = tools.edit_file(str(g), "ANCHOR", "DONE")
    assert out.get("sha256") == hashlib.sha256(g.read_bytes()).hexdigest()
    assert out.get("bytes_on_disk") == g.stat().st_size


def test_proof_still_fails_when_the_bytes_on_disk_are_wrong(tools, workspace, monkeypatch):
    """The detector must still be able to fail."""
    p = workspace / "lied.txt"
    real = write_tools.atomic_replace
    monkeypatch.setattr(
        write_tools, "atomic_replace", lambda path, data: real(path, data[:-1] + b"?")
    )
    out = tools.write_file(str(p), "a\r\nb\r\n")
    assert not out.get("ok"), out
    assert "does not match" in str(out.get("error"))
    assert out.get("sha256") == hashlib.sha256(p.read_bytes()).hexdigest()


def test_no_text_mode_io_remains_on_the_write_path():
    body = Path(write_tools.__file__).read_text(encoding="utf-8")
    assert "read_text(" not in body
    assert "write_text(" not in body
    assert 'errors="replace"' not in body
