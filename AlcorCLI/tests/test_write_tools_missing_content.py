"""A write tool call that leaves the body out must be refused, not laundered into an empty write.

An audit found that the handler collapsed a missing or null ``content`` into ``""``, so a call that
named the file and left the body out (the commonest malformation from a small model) truncated the
file to zero bytes and returned ``ok=True`` with a read-back proof, because an empty file matches
the empty string that was written. ``edit_file`` did the same with a missing ``new_string``.

Three outcomes, never two: wrote, refused-for-no-content, error. Emptying a file deliberately still
works, by passing ``content=""`` explicitly.
"""

from __future__ import annotations

import json

import pytest

from alcorcli.tools import ToolRegistry
from alcorcli.write_tools import WriteTools


@pytest.fixture()
def gate(scope, receipts, policy):
    tools = WriteTools(scope, receipts)
    return tools, ToolRegistry(tools.specs(), scope=scope, policy=policy, receipts=receipts)


def call(registry, name, arguments):
    return json.loads(registry.invoke(name, arguments, owner_enabled=True))


def test_write_file_without_content_is_refused_and_the_file_survives(gate, workspace, receipts):
    _, registry = gate
    target = workspace / "state.json"
    target.write_bytes(b'{"rung": 9, "passed": true}\n')
    out = call(registry, "write_file", {"path": str(target)})
    assert not out.get("ok"), out
    assert out.get("status") == "refused", out
    assert "content" in str(out.get("error"))
    assert target.read_bytes() == b'{"rung": 9, "passed": true}\n'
    writes = [r["body"] for r in receipts.rows() if r["kind"] == "effect.write"]
    assert not any(r.get("ok") for r in writes), "a refused write must not be receipted ok"


def test_content_null_is_absence_not_empty(gate, workspace):
    _, registry = gate
    target = workspace / "state.json"
    target.write_bytes(b"59 bytes of state that must not become zero bytes of state\n")
    out = call(registry, "write_file", {"path": str(target), "content": None})
    assert not out.get("ok"), out
    assert out.get("status") == "refused"
    assert target.read_bytes() != b""


def test_append_file_without_content_is_refused(gate, workspace):
    _, registry = gate
    target = workspace / "log.txt"
    target.write_bytes(b"one\n")
    out = call(registry, "append_file", {"path": str(target)})
    assert not out.get("ok"), out
    assert out.get("status") == "refused"
    assert target.read_bytes() == b"one\n"


def test_deliberate_empty_content_still_empties_the_file(gate, workspace):
    # The third outcome must remain reachable: content="" is a request, not an accident.
    _, registry = gate
    target = workspace / "clear.txt"
    target.write_bytes(b"old\n")
    out = call(registry, "write_file", {"path": str(target), "content": ""})
    assert out.get("ok"), out
    assert target.read_bytes() == b""


def test_edit_file_without_new_string_is_refused_not_a_deletion(gate, workspace):
    _, registry = gate
    target = workspace / "code.py"
    target.write_bytes(b"alpha\nANCHOR\ngamma\n")
    out = call(registry, "edit_file", {"path": str(target), "old_string": "ANCHOR"})
    assert not out.get("ok"), out
    assert out.get("status") == "refused"
    assert target.read_bytes() == b"alpha\nANCHOR\ngamma\n"


def test_edit_file_with_explicit_empty_new_string_deletes_the_anchor(gate, workspace):
    _, registry = gate
    target = workspace / "code.py"
    target.write_bytes(b"alpha\nANCHOR\ngamma\n")
    out = call(
        registry, "edit_file", {"path": str(target), "old_string": "ANCHOR\n", "new_string": ""}
    )
    assert out.get("ok"), out
    assert target.read_bytes() == b"alpha\ngamma\n"


def test_direct_call_with_none_is_refused_too(gate, workspace):
    tools, _ = gate
    target = workspace / "direct.txt"
    target.write_bytes(b"keep\n")
    assert tools.write_file(str(target), None).get("status") == "refused"
    assert target.read_bytes() == b"keep\n"
