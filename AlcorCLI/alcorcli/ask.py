"""The model-call path: route a prompt, call the chosen lane through the gate, receipt the call.

This is the path every plain question takes. In order:

1. **Measure.** Probe each configured lane over loopback. A lane that is unconfigured, refused by
   the loopback rule, unreachable or serving the wrong model is down.
2. **Decide.** ``cli.alcor`` picks a lane from the measured states, the requested lane and the
   prompt's complexity, or refuses with a reason code when nothing is reachable.
3. **Recall.** If the program says memory may be used, the best-matching ledger rows are added to
   the system message. A conversation thread is separate: it is what was said here, verbatim.
4. **Call.** The one guarded transport sends the request. The reply is admitted only if the
   provider says it finished, with one choice and the expected model.
5. **Record.** A ``model.call`` receipt (request and response hashes, usage) is written by the
   transport; an ``ask`` receipt binds it to the routing decision. The thread is appended only
   after a real answer, so a failed turn cannot poison the thread with an unanswered question.
"""

from __future__ import annotations

import re
import time
from collections.abc import Mapping
from typing import Any

from .config import Config
from .digest import sha256_hex
from .errors import AlcorError, EndpointRefused, PolicyError, ReceiptError
from .guard import TurnGuard
from .ledger import ThreadLedger
from .memory import MemoryLedger
from .policy import PolicyHost
from .receipts import ReceiptLog
from .routing import Lane, LaneState, decide_route, probe_all
from .transport import (
    OpenAICompatibleTransport,
    ProviderIncomplete,
    ReceiptingTransport,
    request_defaults,
    require_loopback_base,
)

RESULT_SCHEMA = "alcor.cli.ask-result.v1"
THREAD_NAME = re.compile(r"[A-Za-z0-9._-]{1,64}")
SYSTEM_PREAMBLE = (
    "You answer through a gate that records every call. Answer concretely and briefly. "
    "If you do not know, say so rather than guessing."
)


def _refusal(
    reason: str, route: str, receipts: ReceiptLog, extra: Mapping[str, Any]
) -> dict[str, Any]:
    """Record a refused call and return it. A refusal is a result, not an exception."""
    body = {"reason": reason, "route": route, **extra}
    try:
        receipt_id = receipts.append("model.refused", body)["id"]
    except ReceiptError:
        receipt_id = ""
    return {
        "schema": RESULT_SCHEMA,
        "ok": False,
        "refused": True,
        "route": route,
        "reason": reason,
        "receipt_ids": [receipt_id] if receipt_id else [],
    }


def _admit_answer(response: Mapping[str, Any]) -> str:
    """Admit one finished plain-text answer, or raise ``ProviderIncomplete``.

    A reply that stops mid-sentence is still text that parses, so a delivered token is never an
    answer: either the provider said it finished, or nothing it said counts.
    """
    choices = response.get("choices")
    if (
        response.get("error") is not None
        or not isinstance(choices, list)
        or len(choices) != 1
        or not isinstance(choices[0], dict)
        or choices[0].get("finish_reason") != "stop"
    ):
        raise ProviderIncomplete("ask-completion-incomplete")
    message = choices[0].get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        raise ProviderIncomplete("ask-message-invalid")
    if message.get("refusal") not in (None, ""):
        raise ProviderIncomplete("ask-message-refused")
    if message.get("function_call") is not None or message.get("tool_calls") not in (None, []):
        raise ProviderIncomplete("ask-tool-proposal-unsupported")
    answer = message.get("content")
    if not isinstance(answer, str) or not answer.strip():
        raise ProviderIncomplete("ask-content-invalid")
    return answer.strip()


def ask(
    prompt: str,
    *,
    config: Config,
    policy: PolicyHost,
    lanes: Mapping[str, Lane],
    receipts: ReceiptLog,
    requested: str = "auto",
    endpoint: str | None = None,
    thread: str | None = None,
    use_memory: bool = True,
    timeout: float = 60.0,
    probe_timeout: float = 4.0,
) -> dict[str, Any]:
    """Answer ``prompt`` through the gate and return a result mapping.

    Args:
        prompt: The user's text.
        config: State locations and the effect scope.
        policy: The policy host that runs ``cli.alcor``.
        lanes: The configured lanes.
        receipts: The receipt log every step writes to.
        requested: ``auto``, ``flash``, ``fast`` or ``deep``.
        endpoint: A direct loopback base URL. It skips lane routing but not the loopback rule,
            the response checks or the receipts.
        thread: A conversation name. Prior turns are sent, and this turn is appended after a
            real answer.
        use_memory: Allow recall when the program admits it.
        timeout: Seconds for the model call.
        probe_timeout: Seconds for each lane probe.

    Returns:
        ``ok`` with the ``answer`` and the ``route`` and ``reason`` that chose the lane; or
        ``refused`` with a reason code and a ``model.refused`` receipt. Provider failures after
        dispatch raise, because the caller must not mistake them for a refusal.
    """
    text = str(prompt or "").strip()
    if not text:
        return {"schema": RESULT_SCHEMA, "ok": False, "refused": True, "reason": "nothing-to-ask"}
    if thread is not None and not THREAD_NAME.fullmatch(thread):
        return {
            "schema": RESULT_SCHEMA,
            "ok": False,
            "refused": True,
            "reason": "thread-name-invalid",
        }
    guard = TurnGuard(timeout + probe_timeout * len(lanes), config.stop_paths)
    guard.boundary()

    memory = MemoryLedger(config.memory_path)
    states: dict[str, LaneState] = {}
    decision_fields: dict[str, str] = {}
    policy_receipt: Mapping[str, Any] = {}
    if endpoint is not None:
        # An explicit endpoint skips lane routing, never the loopback rule.
        try:
            base = require_loopback_base(endpoint)
        except EndpointRefused as exc:
            return _refusal(exc.code, "direct", receipts, {"endpoint_sha256": sha256_hex(endpoint)})
        lane = Lane("direct", "explicit endpoint", base)
        states = probe_all({"direct": lane}, probe_timeout)
        if not states["direct"].up:
            return _refusal(
                "endpoint-not-answering", "direct", receipts, {"detail": states["direct"].detail}
            )
        # No program decided anything here, so memory stays out of the prompt.
        route, reason, use_recall = "direct", "explicit-endpoint", False
        model_name = states["direct"].model or "local"
    else:
        states = probe_all(lanes, probe_timeout)
        try:
            decision = decide_route(
                policy, text, requested=requested, states=states, memory_ready=True
            )
        except PolicyError as exc:
            return _refusal(f"cli-program-{exc.code}", "none", receipts, {})
        decision_fields, policy_receipt = dict(decision.fields), decision.receipt
        if decision.get("accepted") != "true":
            return _refusal(
                decision.get("reason"),
                "none",
                receipts,
                {
                    "lane_states": {k: v.detail or "up" for k, v in states.items()},
                    "policy_receipt": dict(policy_receipt),
                },
            )
        route, reason = decision.get("route"), decision.get("reason")
        if route not in lanes:
            return _refusal("route-names-no-configured-lane", route, receipts, {})
        lane = lanes[route]
        use_recall = use_memory and decision.get("memory") == "use"
        model_name = lane.expected_model or states[route].model or "local"

    system = SYSTEM_PREAMBLE
    recalled = memory.recall(text, budget_chars=1400) if use_recall else ""
    if recalled:
        system += (
            "\n\nWhat you have recorded before, which may or may not apply. Use it when relevant "
            "and ignore it when not:\n" + recalled
        )
    prior: list[dict[str, str]] = []
    thread_ledger = None
    if thread:
        thread_ledger = ThreadLedger(config.threads_dir / f"{thread}.jsonl", thread_id=thread)
        prior = [m.as_api() for m in thread_ledger.messages() if m.role in ("user", "assistant")]
    messages = [{"role": "system", "content": system}, *prior, {"role": "user", "content": text}]

    started = time.monotonic()
    transport = ReceiptingTransport(
        OpenAICompatibleTransport(
            lane.base or "",
            expected_model=lane.expected_model,
            request_defaults=request_defaults(False),
            label=lane.id,
        ),
        receipts,
        lane=lane.id,
    )
    guard.boundary()
    response = transport.complete(
        {"model": model_name, "messages": messages, "stream": False, "max_tokens": lane.max_tokens},
        timeout=timeout,
        deadline=guard.deadline,
        guard=guard.check,
    )
    answer = _admit_answer(response)
    guard.boundary()
    # Record the exchange only after a real answer: a failed turn must not poison the thread with
    # a question that was never answered, or the next turn reasons from a false premise.
    if thread_ledger is not None:
        thread_ledger.append_message("user", text)
        thread_ledger.append_message("assistant", answer)
    try:
        receipt = receipts.append(
            "ask",
            {
                "route": route,
                "reason": reason,
                "lane_states": {k: v.detail or "up" for k, v in states.items()},
                "routing_policy": dict(policy_receipt),
                "memory_used": bool(recalled),
                "thread": thread or "",
                "prompt_sha256": sha256_hex(text),
                "answer_sha256": sha256_hex(answer),
                "elapsed_ms": int((time.monotonic() - started) * 1000),
                "task_verified": False,
            },
        )
    except ReceiptError as exc:
        raise AlcorError("ask-receipt-failed", exc.code) from exc
    return {
        "schema": RESULT_SCHEMA,
        "ok": True,
        "refused": False,
        "answer": answer,
        "route": route,
        "reason": reason,
        "model": str(response.get("model") or ""),
        "lane_states": {
            k: {"up": v.up, "model": v.model, "detail": v.detail} for k, v in states.items()
        },
        "decision": decision_fields,
        "memory_used": bool(recalled),
        "receipt_id": receipt["id"],
        "usage": dict(response.get("usage") or {}),
        "task_verified": False,
    }
