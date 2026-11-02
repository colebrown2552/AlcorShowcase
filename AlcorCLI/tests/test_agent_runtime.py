"""The local agent: durable threads, bounded context, explicit tools, and an honest end of turn.

Adapted from the agent-runtime tests of the full system. The model is a scripted in-process
transport, so every test is deterministic and offline.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from alcorcli.agent import Goal, LocalAgent
from alcorcli.context import ContextCompactor, message_weight
from alcorcli.errors import AgentRuntimeError, ToolDenied
from alcorcli.fakes import FakeProvider, ScriptedTransport
from alcorcli.ledger import AgentMessage, ThreadLedger
from alcorcli.limits import MAX_TOOL_ARGUMENT_CHARS
from alcorcli.tools import ToolRegistry, ToolSpec
from alcorcli.transport import OpenAICompatibleTransport


def reply(*calls, content=""):
    """A raw completion that asks for tool calls, in the shape a provider returns."""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": content,
                    "tool_calls": [
                        {"id": ident, "function": {"name": name, "arguments": arguments}}
                        for ident, name, arguments in calls
                    ],
                }
            }
        ]
    }


@pytest.fixture()
def build(tmp_path, scope, policy):
    """Make an agent over a scripted transport and the given tools."""

    def make(script, *tools, thread="t", **options):
        registry = ToolRegistry(tools, scope=scope, policy=policy)
        transport = ScriptedTransport(script)
        agent = LocalAgent(
            ledger=ThreadLedger(tmp_path / f"{thread}.jsonl", thread_id=thread),
            transport=transport,
            model="local",
            tools=registry,
            policy=policy,
            **options,
        )
        return agent, transport

    return make


def test_transport_request_defaults_are_overridden_by_payload():
    with FakeProvider(model="local") as provider:
        transport = OpenAICompatibleTransport(
            provider.base, request_defaults={"temperature": 0, "max_tokens": 1024}
        )
        transport.complete({"model": "local", "max_tokens": 64, "messages": []}, timeout=10)
        sent = provider.requests[0]
        assert sent["max_tokens"] == 64
        assert sent["temperature"] == 0


def test_multiple_turns_reload_thread_memory(tmp_path, policy):
    path = tmp_path / "thread.jsonl"
    LocalAgent(
        ledger=ThreadLedger(path, thread_id="t1"),
        transport=ScriptedTransport(["first"]),
        model="local",
        policy=policy,
    ).turn("remember: blue")
    transport = ScriptedTransport(["I remember blue"])
    second = LocalAgent(
        ledger=ThreadLedger(path, thread_id="t1"), transport=transport, model="local", policy=policy
    )
    result = second.turn("what did I say?")
    assert result["reply"] == "I remember blue"
    assert len(transport.payloads[0]["messages"]) == 3


def test_distinct_ledger_instances_serialize_concurrent_appends(tmp_path):
    path = tmp_path / "concurrent.jsonl"

    def append(index):
        ThreadLedger(path, thread_id="concurrent").append_message("user", f"message-{index}")

    with ThreadPoolExecutor(max_workers=24) as executor:
        list(executor.map(append, range(200)))
    messages = ThreadLedger(path, thread_id="concurrent").messages()
    assert len(messages) == 200
    assert {m.content for m in messages} == {f"message-{i}" for i in range(200)}


def test_compaction_is_bounded_and_ledger_preserves_full_history(tmp_path, policy):
    path = tmp_path / "thread.jsonl"
    transport = ScriptedTransport(["done"])
    agent = LocalAgent(
        ledger=ThreadLedger(path, thread_id="t2"),
        transport=transport,
        model="local",
        policy=policy,
        compactor=ContextCompactor(max_chars=5_000, keep_recent=2),
    )
    for index in range(5):
        agent.ledger.append_message("assistant", f"observation-{index} {'x' * 2_500}")
        agent.ledger.append_message("assistant", f"reply-{index}")
    result = agent.turn("latest")
    assert result["compacted"]
    assert sum(len(m["content"]) for m in transport.payloads[0]["messages"]) <= 5_000
    assert len(ThreadLedger(path, thread_id="t2").messages()) >= 11


def test_goal_is_injected_without_becoming_a_second_ledger(tmp_path, policy):
    transport = ScriptedTransport(["goal acknowledged"])
    agent = LocalAgent(
        ledger=ThreadLedger(tmp_path / "thread.jsonl", thread_id="goal"),
        transport=transport,
        model="local",
        policy=policy,
        goal=Goal("test the gate", ("never use an unregistered tool",)),
    )
    agent.turn("hello")
    assert "Goal: test the gate" in transport.payloads[0]["messages"][0]["content"]
    assert len(agent.ledger.messages()) == 2


def test_read_only_tool_runs_and_mutating_tool_fails_closed(build, scope, policy):
    registry = ToolRegistry(
        [
            ToolSpec("inspect", "read-only", lambda args: {"value": args["value"]}),
            ToolSpec("write", "mutating", lambda args: {"wrote": True}, mutating=True),
        ],
        scope=scope,
        policy=policy,
    )
    assert json.loads(registry.invoke("inspect", {"value": 3}, owner_enabled=False))["value"] == 3
    with pytest.raises(ToolDenied, match="owner-enablement"):
        registry.invoke("write", {}, owner_enabled=False)
    agent, transport = build(
        [reply(("c1", "inspect", json.dumps({"value": 3}))), "tool complete"],
        ToolSpec("inspect", "read-only", lambda args: {"value": args["value"]}),
    )
    result = agent.turn("inspect")
    assert result["reply"] == "tool complete"
    assert result["tool_calls"][0]["name"] == "inspect"
    follow_up = transport.payloads[1]["messages"]
    assert follow_up[-2]["role"] == "assistant"
    assert follow_up[-2]["tool_calls"][0]["id"] == "c1"
    assert follow_up[-1]["role"] == "tool"
    assert follow_up[-1]["tool_call_id"] == "c1"


def test_oversized_recent_user_message_refuses_without_changing_ledger(tmp_path):
    path = tmp_path / "thread.jsonl"
    ledger = ThreadLedger(path, thread_id="large")
    ledger.append_message("user", "x" * 2_000)
    before = path.read_bytes()
    with pytest.raises(AgentRuntimeError, match="context-instructions-over-budget"):
        ContextCompactor(max_chars=512, keep_recent=1).compact(ledger.messages())
    assert path.read_bytes() == before
    assert len(ledger.messages()[0].content) == 2_000


def test_compaction_drops_partial_multi_tool_groups():
    """A bounded window must never send an incomplete tool-call envelope."""
    calls = tuple(
        {"id": f"call-{i}", "type": "function", "function": {"name": "inspect", "arguments": "{}"}}
        for i in range(3)
    )
    messages = [
        AgentMessage("assistant", "old" * 1_000, "old", 0),
        AgentMessage("user", "inspect", "user", 1),
        AgentMessage("assistant", "", "assistant-tools", 2, tool_calls=calls),
        AgentMessage("tool", "one", "tool-0", 3, tool_call_id="call-0"),
        AgentMessage("tool", "two", "tool-1", 4, tool_call_id="call-1"),
        AgentMessage("tool", "three", "tool-2", 5, tool_call_id="call-2"),
        AgentMessage("assistant", "complete", "assistant-final", 6),
        AgentMessage("user", "latest", "latest", 7),
    ]
    projected, record = ContextCompactor(max_chars=512, keep_recent=3).compact(messages)
    assert record is not None
    tool_ids = {m.tool_call_id for m in projected if m.role == "tool"}
    envelopes = [m for m in projected if m.role == "assistant" and m.tool_calls]
    # Either omit the historical transaction or retain every call and result. The failure was a
    # partial envelope, not its valid retention.
    assert tool_ids in (set(), {"call-0", "call-1", "call-2"})
    assert bool(envelopes) == bool(tool_ids)
    if envelopes:
        assert {call["id"] for call in envelopes[0].tool_calls} == tool_ids
    assert sum(len(m.content) for m in projected) <= 512


def boom(_args):
    raise ValueError("nope")


def test_tool_error_terminates_turn_instead_of_retrying_forever(build):
    agent, transport = build(
        [reply(("bad", "inspect", json.dumps({"value": 1})))], ToolSpec("inspect", "fails", boom)
    )
    result = agent.turn("go")
    assert result["ok"] is False
    assert result["failure_class"] == "tool_failed"
    assert len(transport.payloads) == 1


def test_read_only_tool_error_can_recover_once(build):
    agent, transport = build(
        [reply(("bad", "inspect", "{}")), "recovered"],
        ToolSpec("inspect", "read-only", boom),
        recover_tool_errors=True,
        max_tool_error_retries=1,
    )
    result = agent.turn("go")
    assert result["ok"] is True
    assert result["reply"] == "recovered"
    assert len(transport.payloads) == 2
    assert result["tool_calls"][0]["ok"] is False


def test_recovered_tool_error_has_a_bounded_retry(build):
    agent, transport = build(
        [
            reply(("bad-1", "inspect", "{}")),
            reply(("bad-2", "inspect", "{}")),
            "gave up on the tool",
        ],
        ToolSpec("inspect", "read-only", boom),
        recover_tool_errors=True,
        max_tool_error_retries=1,
    )
    result = agent.turn("go")
    # A recovering agent ends by reporting, and the retry is bounded: exactly one extra model call
    # with the tool schemas removed so it cannot call anything.
    assert result["ok"] is True
    assert result["ended_because"] == "tool_errors"
    assert result["reply"] == "gave up on the tool"
    assert len(transport.payloads) == 3
    assert "tools" not in transport.payloads[-1]
    assert transport.payloads[-1]["tool_choice"] == "none"


def test_strict_agent_still_fails_hard_on_a_tool_error(build):
    agent, _ = build(
        [reply(("bad", "inspect", "{}"))],
        ToolSpec("inspect", "read-only", boom),
        recover_tool_errors=False,
    )
    result = agent.turn("go")
    assert result["ok"] is False
    assert result["failure_class"] == "tool_failed"
    assert "reply" not in result


def test_tool_error_counter_measures_consecutive_failures_not_lifetime_ones(build):
    """One failure early plus one much later must not end the turn regardless of clean work
    between them."""
    state = {"n": 0}

    def flaky(args):
        state["n"] += 1
        if state["n"] in (1, 3):
            raise ValueError("transient")
        return {"ok": True, "n": state["n"]}

    def probe(i):
        return reply((f"c{i}", "probe", json.dumps({"i": i})))

    agent, _ = build(
        [probe(1), probe(2), probe(3), "finished after a wobble"],
        ToolSpec("probe", "read-only", flaky),
        recover_tool_errors=True,
        max_tool_error_retries=1,
    )
    result = agent.turn("go")
    assert result["ok"] is True
    assert result["reply"] == "finished after a wobble"
    assert result["ended_because"] == "model_finished"


def probe_call(i, content=""):
    return reply((f"c{i}", "probe", json.dumps({"i": i})), content=content)


def test_round_budget_ends_in_an_answer_rather_than_an_exception(build):
    # Two tool calls against a budget of 2. kernel.alcor settles the round in which the cap is
    # reached, so the next model call is already the forced-final one.
    agent, transport = build(
        [probe_call(1), probe_call(2), "here is what I found"],
        ToolSpec("probe", "read-only", lambda args: {"seen": args["i"]}),
        max_tool_rounds=2,
    )
    result = agent.turn("go")
    assert result["ok"] is True
    assert result["ended_because"] == "budget"
    assert result["reply"] == "here is what I found"
    assert result["tool_rounds"] == 2
    assert "tools" not in transport.payloads[-1]


def test_a_tool_call_after_finalization_keeps_the_prose_instead_of_raising(build):
    agent, _ = build(
        [
            probe_call(1, "partial finding"),
            probe_call(2, "partial finding"),
            probe_call(3, "partial finding"),
        ],
        ToolSpec("probe", "read-only", lambda args: {"seen": args["i"]}),
        max_tool_rounds=1,
    )
    result = agent.turn("go")
    assert result["ok"] is True
    assert result["ended_because"] == "budget"
    assert result["reply"] == "partial finding"


def test_the_model_is_told_the_budget_it_is_spending(build):
    agent, transport = build(
        [reply(("c1", "probe", "{}")), "done"],
        ToolSpec("probe", "read-only", lambda args: {"ok": True}),
        max_tool_rounds=10,
    )
    agent.turn("go")
    first = transport.payloads[0]["messages"][0]["content"]
    second = transport.payloads[1]["messages"][0]["content"]
    assert "Tool round 0 of 10" in first
    assert "Tool round 1 of 10" in second
    # Task-neutral: naming a tool or an artifact here would make any later result a product of
    # this sentence rather than of the model's own judgement.
    for word in ("write", "file", "shell", "artifact"):
        assert word not in first.lower()


def test_an_unreadable_tool_call_is_reported_back_instead_of_killing_the_turn(build, tmp_path):
    """A write whose content exceeded the argument cap once destroyed a turn after fifteen rounds
    of real work, and the caller got no reply at all."""
    huge = reply(("big", "probe", "x" * 300_000))
    agent, transport = build(
        [huge, reply(("ok", "probe", "{}")), "did it in pieces"],
        ToolSpec("probe", "read-only", lambda args: {"ok": True}),
        thread="unreadable",
        recover_tool_errors=True,
        max_tool_error_retries=2,
        max_tool_rounds=8,
    )
    result = agent.turn("go")
    assert result["ok"] is True
    assert result["reply"] == "did it in pieces"
    assert result["malformed_tool_calls"] == 1
    # The model must be told, or it will reissue the same oversized call.
    complaint = json.dumps(transport.payloads[1]["messages"])
    assert "could not be read" in complaint
    assert "smaller pieces" in complaint
    # No dangling tool_call ids: a half-normalised envelope makes replay invalid.
    rows = [json.loads(line) for line in agent.ledger.path.open() if line.strip()]
    assert "big" not in [c["id"] for r in rows for c in (r.get("tool_calls") or [])]


def test_a_malformed_tool_call_is_recoverable(build):
    broken = reply(("x", "probe", "{this is not json"))
    agent, transport = build(
        [broken, "plain prose instead"],
        ToolSpec("probe", "read-only", lambda args: {"ok": True}),
        recover_tool_errors=True,
        max_tool_error_retries=2,
    )
    result = agent.turn("go")
    assert result["ok"] is True
    assert result["reply"] == "plain prose instead"
    assert result["malformed_tool_calls"] == 1
    assert "could not be read" in json.dumps(transport.payloads[1]["messages"])


def test_the_budget_counts_tool_calls_not_only_content():
    """A third of a live payload was invisible to the budget meant to bound it."""
    pad = "x" * 300
    bare = AgentMessage("assistant", "", "m1", 0.0)
    with_calls = AgentMessage(
        "assistant",
        "",
        "m2",
        0.0,
        tool_calls=(
            {
                "id": "c1",
                "type": "function",
                "function": {"name": "shell", "arguments": f'{{"command":"{pad}"}}'},
            },
        ),
    )
    assert message_weight(bare) == 0
    assert message_weight(with_calls) > 300


def test_compaction_triggers_on_tool_call_weight_alone():
    """A run of empty-content assistant messages with large tool calls once looked weightless, so
    compaction never fired and the request grew until the server refused it."""
    messages = [AgentMessage("system", "brief", "s", 0.0)]
    for i in range(20):
        call = {
            "id": f"c{i}",
            "type": "function",
            "function": {"name": "shell", "arguments": '{"command":"%s"}' % ("y" * 400)},
        }
        messages.append(AgentMessage("assistant", "", f"a{i}", 0.0, tool_calls=(call,)))
        messages.append(AgentMessage("tool", "ok", f"t{i}", 0.0, tool_call_id=f"c{i}"))
    _projected, compaction = ContextCompactor(max_chars=3000, keep_recent=4).compact(messages)
    assert compaction is not None


def test_a_file_sized_argument_is_allowed_through():
    assert MAX_TOOL_ARGUMENT_CHARS >= 100_000


def test_an_agent_with_no_tools_is_never_told_about_tool_rounds(tmp_path, policy):
    transport = ScriptedTransport(["just talking"])
    LocalAgent(
        ledger=ThreadLedger(tmp_path / "thread.jsonl", thread_id="chat"),
        transport=transport,
        model="local",
        policy=policy,
    ).turn("hello")
    assert "Tool round" not in json.dumps(transport.payloads[0]["messages"])


def test_duplicate_read_only_tool_result_forces_one_final_answer(build):
    calls = {"count": 0}

    def inspect(_args):
        calls["count"] += 1
        return {"fact": "bounded"}

    agent, transport = build(
        [reply(("one", "inspect", "{}")), reply(("two", "inspect", "{}")), "final answer"],
        ToolSpec("inspect", "read-only", inspect),
        force_final_after_duplicate_tool=True,
    )
    result = agent.turn("go")
    assert result["ok"] is True
    assert result["reply"] == "final answer"
    assert calls["count"] == 1
    assert result["duplicate_tool_calls"] == 1
    assert transport.payloads[2]["tool_choice"] == "none"


def test_oversized_json_tool_result_remains_valid_and_bounded(scope, policy):
    registry = ToolRegistry(
        (ToolSpec("large", "large", lambda _args: {"text": "x" * 100_000}),),
        scope=scope,
        policy=policy,
    )
    rendered = registry.invoke("large", {}, owner_enabled=False)
    assert len(rendered) <= 16_384
    parsed = json.loads(rendered)
    assert parsed["truncated"] is True
    assert len(parsed["result_sha256"]) == 64


class Repeater:
    """A transport that asks for the same tool call until it is told to answer in prose."""

    def __init__(self, arguments, final):
        self.arguments, self.final, self.payloads = arguments, final, []

    def complete(self, payload, *, timeout, **options):
        self.payloads.append(payload)
        if payload.get("tool_choice") == "none":
            return {"choices": [{"message": {"role": "assistant", "content": self.final}}]}
        return reply((f"call-{len(self.payloads)}", "shell", self.arguments))


def agent_over(tmp_path, policy, scope, transport, handler, **options):
    registry = ToolRegistry(
        (ToolSpec("shell", "shell", handler, mutating=True),), scope=scope, policy=policy
    )
    return LocalAgent(
        ledger=ThreadLedger(tmp_path / "t.jsonl", thread_id="dup"),
        transport=transport,
        model="local",
        tools=registry,
        policy=policy,
        owner_enabled=True,
        **options,
    )


def test_mutating_tool_is_never_served_from_the_duplicate_cache(tmp_path, scope, policy):
    """A repeated effectful call must run again, not be answered from cache. A cache keyed on
    name and arguments once returned the first result verbatim: the command never ran, no receipt
    was written, and the transcript recorded a success."""
    from alcorcli.write_tools import WriteTools

    arguments = json.dumps({"path": "log.txt", "content": "one\n"})
    script = [
        reply(("a", "append_file", arguments)),
        reply(("b", "append_file", arguments)),
        "done",
    ]
    registry = ToolRegistry(WriteTools(scope).specs(), scope=scope, policy=policy)
    agent = LocalAgent(
        ledger=ThreadLedger(tmp_path / "t.jsonl", thread_id="dup"),
        transport=ScriptedTransport(script),
        model="local",
        tools=registry,
        policy=policy,
        owner_enabled=True,
        force_final_after_duplicate_tool=True,
    )
    agent.turn("go")
    assert (scope.workspace / "log.txt").read_text(encoding="utf-8").splitlines() == ["one", "one"]


def test_identical_mutating_receipts_force_reassessment_after_execution(tmp_path, scope, policy):
    calls = {"count": 0}

    def shell(_args):
        calls["count"] += 1
        return {"ok": True, "stdout": "unchanged"}

    transport = Repeater(json.dumps({"command": "grep needle ."}), "I am reassessing.")
    result = agent_over(
        tmp_path,
        policy,
        scope,
        transport,
        shell,
        force_final_after_duplicate_tool=True,
        max_tool_rounds=8,
    ).turn("find the thing")
    assert result["ok"] is True
    assert calls["count"] == 2, "both effect receipts must be real executions"
    assert result["duplicate_tool_calls"] == 1
    assert result["ended_because"] == "duplicate"
    assert transport.payloads[-1]["tool_choice"] == "none"


def test_three_consecutive_same_calls_force_reassessment_when_results_change(
    tmp_path, scope, policy
):
    calls = {"count": 0}

    def shell(_args):
        calls["count"] += 1
        return {"ok": True, "stdout": f"growing-{calls['count']}"}

    transport = Repeater(
        json.dumps({"command": "grep -r needle ."}), "I need a different observation."
    )
    result = agent_over(tmp_path, policy, scope, transport, shell, max_tool_rounds=8).turn(
        "find it"
    )
    assert result["ok"] is True
    assert calls["count"] == 3
    assert result["ended_because"] == "stagnation"
    assert transport.payloads[-1]["tool_choice"] == "none"


def test_compaction_refuses_when_the_system_text_is_oversized(tmp_path):
    """A goal larger than the budget must not silently delete the instruction."""
    goal = Goal("O" * 4096, tuple("C" * 512 for _ in range(16)))
    ledger = ThreadLedger(tmp_path / "thread.jsonl", thread_id="oversized-system")
    ledger.append_message("system", goal.system_text())
    ledger.append_message("user", "THE ACTUAL INSTRUCTION")
    before = ledger.path.read_bytes()
    with pytest.raises(AgentRuntimeError, match="context-instructions-over-budget"):
        ContextCompactor(max_chars=12_000, keep_recent=8).compact(ledger.messages())
    assert ledger.path.read_bytes() == before
    assert [m.content for m in ledger.messages()] == [goal.system_text(), "THE ACTUAL INSTRUCTION"]
