"""A sibling directory that merely begins with a root's name is outside the root.

An audit found that a root check written as ``str(resolved).startswith(str(root))`` let a write to
``root-old/notes.md`` pass for a root named ``root``, ``mkdir`` created the sibling directory, and
the read-back returned ``ok`` with a hash: a receipted write to a directory that never was a root.
The comparison is now by path component.
"""

from __future__ import annotations

import pytest

from alcorcli.config import Scope
from alcorcli.write_tools import WriteTools


@pytest.fixture()
def fixture(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    scope = Scope.for_workspace(root, environ={})
    return tmp_path, root, scope, WriteTools(scope)


def test_a_sibling_sharing_the_prefix_is_outside(fixture):
    parent, _, scope, _ = fixture
    assert not scope.contains(parent / "root-old" / "notes.md")
    assert not scope.contains(parent / "rootBACKUP" / "deep" / "y.py")
    assert not scope.contains(parent / "root2.txt")


def test_the_root_and_its_children_are_inside(fixture):
    _, root, scope, _ = fixture
    assert scope.contains(root)
    assert scope.contains(root / "curriculum" / "aggregate.txt")


def test_a_write_to_the_sibling_is_refused_and_creates_nothing(fixture):
    parent, _, _, tools = fixture
    out = tools.write_file(str(parent / "root-old" / "notes.md"), "x\n")
    assert not out.get("ok"), out
    assert "outside" in str(out.get("error"))
    assert not (parent / "root-old").exists(), "the refused write created the sibling directory"
