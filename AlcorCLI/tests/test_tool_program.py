"""tool.alcor: every tool call passes a program before it runs.

The host computes cells; the program returns allow, deny or ask_owner; the host obeys. A call the
program could not judge does not run.
"""

from __future__ import annotations

import json

import pytest

from alcorcli.config import Scope
from alcorcli.errors import ToolDenied
from alcorcli.policy import PolicyHost
from alcorcli.tools import ToolRegistry, ToolSpec, tool_cells


@pytest.fixture()
def registry_for(scope, receipts, policy):
    def build(name="shell", mutating=True):
        spec = ToolSpec(
            name=name,
            description="t",
            handler=lambda a: {"ok": True, "echo": dict(a)},
            mutating=mutating,
        )
        return ToolRegistry([spec], scope=scope, policy=policy, receipts=receipts)

    return build


def test_program_lints(policy):
    assert policy.find_program("tool").is_file()
    assert policy.check("tool")["ok"]


def test_ordinary_shell_is_allowed_and_receipted(registry_for, receipts):
    out = registry_for().invoke("shell", {"command": "ls notes"}, owner_enabled=True)
    assert json.loads(out)["ok"] is True
    decisions = [r["body"] for r in receipts.rows() if r["kind"] == "tool.decision"]
    assert decisions[-1]["verdict"] == "allow"


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf /",
        "cat ~/.ssh/id_ed25519",
        "git push --force origin main",
        "launchctl unload x",
        "Remove-Item -Recurse $HOME/.alcor",
    ],
)
def test_forbidden_pattern_is_denied(registry_for, command):
    with pytest.raises(ToolDenied) as caught:
        registry_for().invoke("shell", {"command": command}, owner_enabled=True)
    assert caught.value.reason == "forbidden-pattern"


def test_owner_class_effect_allowed_only_when_owner_enabled(registry_for):
    registry = registry_for()
    with pytest.raises(ToolDenied) as caught:
        registry.invoke("shell", {"command": "git push origin main"}, owner_enabled=False)
    assert caught.value.verdict == "ask_owner"
    registry.invoke("shell", {"command": "git push origin main"}, owner_enabled=True)


def test_mutating_without_owner_still_asks(registry_for):
    with pytest.raises(ToolDenied) as caught:
        registry_for("write_file").invoke(
            "write_file", {"path": "x.txt", "content": "1"}, owner_enabled=False
        )
    assert caught.value.verdict == "ask_owner"
    assert "owner-enablement" in caught.value.reason


def test_path_outside_roots_is_denied(registry_for, tmp_path):
    outside = str(tmp_path / "elsewhere.txt")
    with pytest.raises(ToolDenied) as caught:
        registry_for("read_file", mutating=False).invoke(
            "read_file", {"path": outside}, owner_enabled=True
        )
    assert caught.value.reason == "the-path-leaves-the-allowed-roots"
    registry_for("read_file", mutating=False).invoke(
        "read_file", {"path": "inside.txt"}, owner_enabled=True
    )


def test_write_into_a_protected_input_is_denied(workspace, receipts, policy):
    # The graded input is read-only: an agent hunting for progress once edited the theory it was
    # being graded against and made the task unsatisfiable.
    inputs = workspace / "inputs"
    inputs.mkdir()
    scope = Scope.for_workspace(workspace, protected=(inputs,), environ={})
    spec = ToolSpec("write_file", "t", lambda a: {"ok": True}, mutating=True)
    registry = ToolRegistry([spec], scope=scope, policy=policy, receipts=receipts)
    for target in ("inputs/theory.md", str(inputs / "cases.json")):
        with pytest.raises(ToolDenied) as caught:
            registry.invoke("write_file", {"path": target, "content": "x"}, owner_enabled=True)
        assert caught.value.reason == "protected-input-is-read-only-write-your-output-elsewhere"


def test_reading_a_protected_input_and_writing_elsewhere_is_allowed(workspace):
    inputs = workspace / "inputs"
    inputs.mkdir()
    scope = Scope.for_workspace(workspace, protected=(inputs,), environ={})
    read = tool_cells("read_file", False, {"path": "inputs/theory.md"}, True, scope)
    assert read["protected_input"] == "no"
    write = tool_cells("write_file", True, {"path": "out/derived.json"}, True, scope)
    assert write["protected_input"] == "no"


def test_unknown_tool_kind_defaults_by_mutating(registry_for, scope):
    cells = tool_cells("echo", False, {"text": "hi"}, False, scope)
    assert cells["tool_kind"] == "read"
    assert cells["owner_verdict"] == "proceed"
    registry_for("echo", mutating=False).invoke("echo", {"text": "hi"}, owner_enabled=False)


def test_unavailable_program_is_deny(scope, receipts, tmp_path):
    empty = tmp_path / "no-programs"
    empty.mkdir()
    spec = ToolSpec("shell", "t", lambda a: {"ok": True}, mutating=True)
    registry = ToolRegistry(
        [spec], scope=scope, policy=PolicyHost(programs_dir=empty), receipts=receipts
    )
    with pytest.raises(ToolDenied) as caught:
        registry.invoke("shell", {"command": "ls"}, owner_enabled=True)
    assert caught.value.reason.startswith("tool-program-")
