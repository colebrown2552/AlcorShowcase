"""The one HTTP path to a model. Everything that speaks to a model goes through here.

Three rules are enforced at this chokepoint, not left to each caller:

* **Loopback only.** The URL must be ``http://`` to ``127.0.0.1``, ``localhost`` or ``::1`` with an
  explicit port, no credentials in the URL, and the resolved address must be loopback too. A
  remote machine is reached through a local tunnel, so the gate never speaks to a routable host.
* **Bounded and strict.** One deadline covers the whole request, redirects are refused, the
  response is at most 4 MiB of UTF-8 JSON with complete HTTP framing, and duplicate keys or
  NaN/Infinity are errors. A cancellation monitor thread aborts the socket the moment the
  operator's STOP file appears or the deadline passes.
* **A finished completion or nothing.** Text that stops mid-sentence is still text that parses,
  so a reply is admitted only when the provider says it finished, with exactly one choice and a
  model identity that matches what was asked for.
"""

from __future__ import annotations

import contextlib
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Mapping
from typing import Any, Protocol
from urllib.parse import urlsplit

from .digest import sha256_hex
from .errors import AgentRuntimeError, AlcorError, EndpointRefused
from .limits import MAX_TOOL_ARGUMENT_CHARS, bounded_text
from .receipts import ReceiptLog

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
RESPONSE_LIMIT = 4 * 1024 * 1024
CHAT_PATH = "/v1/chat/completions"


class ProviderError(AlcorError):
    """The provider refused the request or the connection failed."""


class ProviderIncomplete(AlcorError):
    """A reply that stopped before it finished, refused before any caller can read it."""


class ModelIdentityError(AlcorError):
    """A response could not prove the model identity the lane expects."""


def require_loopback_base(base: str) -> str:
    """Return the normalised base URL, or refuse it.

    Raises:
        EndpointRefused: Unless the URL is plain ``http`` to a loopback host with an explicit
            port, no userinfo, no query, no fragment and no path.
    """
    code = "endpoint-must-be-http-loopback"
    try:
        parts = urlsplit(str(base).strip())
        port = parts.port
    except ValueError as exc:
        raise EndpointRefused(code, "unparseable") from exc
    if (
        parts.scheme != "http"
        or parts.hostname not in LOOPBACK_HOSTS
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or parts.path not in ("", "/")
        or port is None
    ):
        raise EndpointRefused(code, (parts.hostname or "no-host")[:60])
    host = f"[{parts.hostname}]" if ":" in (parts.hostname or "") else parts.hostname
    return f"http://{host}:{port}"


def is_loopback_address(address: str) -> bool:
    """True when ``address`` is an IP literal in the loopback range (IPv4-mapped IPv6 included)."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    return (mapped or ip).is_loopback


class _Control:
    """Cancellation state shared by the calling thread and the monitor thread."""

    def __init__(self, deadline: float, guard: Callable[[], Any] | None) -> None:
        self.deadline = deadline
        self.guard = guard
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.socket: socket.socket | None = None
        self.error: BaseException | None = None

    def abort(self) -> None:
        """Shut the tracked socket down so a blocked read returns at once."""
        with self.lock:
            sock, self.socket = self.socket, None
        if sock is None:
            return
        with contextlib.suppress(OSError):
            sock.shutdown(socket.SHUT_RDWR)
        if os.name == "nt":
            # On Windows ``makefile`` can keep the OS handle alive after close. Detach closes
            # that exact handle without leaving a later double close.
            with contextlib.suppress(OSError):
                handle = sock.detach()
                if handle != -1:
                    socket.close(handle)
        sock.close()

    def check(self) -> None:
        """Raise the first recorded error, the deadline, or whatever the guard raises."""
        with self.lock:
            error = self.error
        if error is not None:
            raise error
        try:
            if time.monotonic() >= self.deadline:
                raise TimeoutError("provider-request-deadline-exhausted")
            if self.guard is not None:
                self.guard()
        except BaseException as exc:
            with self.lock:
                if self.error is None:
                    self.error = exc
                error = self.error
            self.abort()
            raise error from None

    def track(self, sock: socket.socket) -> None:
        """Remember the socket so ``abort`` can reach it, then check once."""
        with self.lock:
            self.socket = sock
        self.check()

    def watch(self) -> None:
        """Monitor thread body: poll until the request ends or a check fails."""
        while not self.done.wait(0.025):
            try:
                self.check()
            except BaseException:
                return


class _StrictResponse(http.client.HTTPResponse):
    """An HTTP response that insists on complete chunked framing.

    The standard library tolerates EOF in place of the final chunk terminator and discards chunk
    delimiters without checking them. A model reply cut short must not look complete.
    """

    def _read_next_chunk_size(self) -> int:
        line = self.fp.readline(http.client._MAXLINE + 1)
        if len(line) > http.client._MAXLINE:
            raise http.client.LineTooLong("chunk size")
        token = line[:-2].split(b";", 1)[0]
        if not line.endswith(b"\r\n") or not re.fullmatch(b"[0-9a-fA-F]+", token):
            raise http.client.IncompleteRead(b"")
        return int(token, 16)

    def _get_chunk_left(self) -> int | None:
        if self.chunk_left == 0:
            if self._safe_read(2) != b"\r\n":
                raise http.client.IncompleteRead(b"")
            self.chunk_left = None
        return super()._get_chunk_left()

    def _read_and_discard_trailer(self) -> None:
        size = 0
        while True:
            line = self.fp.readline(http.client._MAXLINE + 1)
            size += len(line)
            if size > http.client._MAXLINE:
                raise http.client.LineTooLong("chunk trailer")
            if not line.endswith(b"\r\n"):
                raise http.client.IncompleteRead(b"")
            if line == b"\r\n":
                return


def _connection_class(control: _Control) -> type[http.client.HTTPConnection]:
    """Build a connection class whose every step consults ``control``."""

    class GuardedConnection(http.client.HTTPConnection):
        response_class = _StrictResponse

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            # HTTPConnection calls this before it can send even a proxy CONNECT.
            self._create_connection = self._guarded_create

        def _guarded_create(
            self, address: tuple[str, int], timeout: float, source_address: Any = None
        ) -> socket.socket:
            control.check()
            host, port = address
            # Resolve first and refuse any non-loopback answer before a socket exists. A name
            # such as "localhost" passes the string check, so the addresses are checked too.
            infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
            control.check()
            if not infos or not all(is_loopback_address(str(i[4][0])) for i in infos):
                raise EndpointRefused("endpoint-resolves-off-loopback", host[:60])
            error: OSError = OSError("endpoint resolved to no addresses")
            for family, kind, proto, _canonical, sockaddr in infos:
                sock = socket.socket(family, kind, proto)
                try:
                    control.track(sock)
                    sock.settimeout(min(timeout, max(0.001, control.deadline - time.monotonic())))
                    if source_address:
                        sock.bind(source_address)
                    sock.connect(sockaddr)
                    control.check()
                    return sock
                except OSError as exc:
                    error = exc
                    sock.close()
                    control.check()
            raise error

        def send(self, data: Any) -> None:
            control.check()
            super().send(data)

    return GuardedConnection


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: the gate admits only the endpoint it was asked to call."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _finite_float(text: str) -> float:
    number = float(text)
    if not math.isfinite(number):
        raise ValueError("nonfinite JSON number")
    return number


def _reject_constant(name: str) -> None:
    raise ValueError("nonfinite JSON constant")


def strict_json(text: str) -> Any:
    """Parse JSON, refusing duplicate keys and NaN/Infinity.

    Raises:
        ValueError: On malformed JSON, a repeated key or a non-finite number.
    """
    return json.loads(
        text,
        object_pairs_hook=_unique_pairs,
        parse_float=_finite_float,
        parse_constant=_reject_constant,
    )


def _read_bounded(handle: Any, control: _Control, limit: int) -> bytes:
    lengths = handle.headers.get_all("Content-Length", [])
    transfers = handle.headers.get_all("Transfer-Encoding", [])
    if len(lengths) > 1 or (lengths and transfers):
        raise ProviderError("response-ambiguous-framing")
    if transfers and [t.lower().strip() for t in transfers] != ["chunked"]:
        raise ProviderError("response-unsupported-transfer-encoding")
    declared = None
    if lengths:
        if not re.fullmatch(r"[0-9]+", lengths[0].strip()):
            raise ProviderError("response-invalid-content-length")
        declared = int(lengths[0])
        if declared > limit:
            raise ProviderError("response-exceeds-byte-limit")
    chunks: list[bytes] = []
    size = 0
    while True:
        control.check()
        part = handle.read1(min(65536, limit + 1 - size))
        if not part:
            break
        size += len(part)
        if size > limit:
            raise ProviderError("response-exceeds-byte-limit")
        chunks.append(part)
    control.check()
    if declared is not None and size != declared:
        raise ProviderError("response-incomplete-content-length")
    return b"".join(chunks)


def guarded_http(
    request: urllib.request.Request,
    timeout: float,
    deadline: float | None = None,
    guard: Callable[[], Any] | None = None,
    *,
    response_limit: int = RESPONSE_LIMIT,
    accepted_types: tuple[type, ...] = (dict,),
) -> Any:
    """Send one request with a joined cancellation monitor and return the decoded JSON.

    DNS resolution is a synchronous OS call and cannot be interrupted, so a late resolution must
    pass ``guard`` before any request byte is sent. Numeric loopback avoids the problem.

    Args:
        request: The request. Its URL is checked against the loopback rule again here, so no
            caller can bypass the check by building a request by hand.
        timeout: Socket timeout in seconds.
        deadline: Absolute ``time.monotonic()`` bound for the whole request.
        guard: Called repeatedly from a monitor thread; raise to cancel.
        response_limit: Maximum response bytes.
        accepted_types: JSON container types the caller will accept.

    Raises:
        EndpointRefused: If the URL is not loopback http.
        ProviderError: On an HTTP error status or invalid response.
        TimeoutError: If the deadline passes.
    """
    parts = urlsplit(request.full_url)
    require_loopback_base(f"{parts.scheme}://{parts.netloc}")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("provider-request-timeout-must-be-positive-finite")
    now = time.monotonic()
    deadline = min(deadline, now + timeout) if deadline is not None else now + timeout
    control = _Control(deadline, guard)
    control.check()
    handler_class = _connection_class(control)

    class HTTP(urllib.request.HTTPHandler):
        def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
            return self.do_open(handler_class, req)

    monitor = threading.Thread(target=control.watch, name="alcor-model-guard")
    monitor.start()
    try:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), HTTP(), _RefuseRedirect()
        )
        try:
            control.check()
            response = opener.open(request, timeout=min(timeout, max(0.001, deadline - now)))
        except urllib.error.HTTPError as exc:
            with exc:
                detail = _read_bounded(exc, control, response_limit).decode("utf-8", "replace")[
                    :600
                ]
            raise ProviderError(f"http-{int(exc.code)}", f"{exc.reason} -- {detail}") from exc
        with response as handle:
            raw = _read_bounded(handle, control, response_limit)
        try:
            decoded = strict_json(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError) as exc:
            raise ProviderError("response-invalid-json") from exc
        control.check()
        if not isinstance(decoded, accepted_types):
            raise ProviderError("response-unexpected-json-type")
        return decoded
    except http.client.HTTPException as exc:
        control.check()
        raise ProviderError("response-invalid-http") from exc
    except BaseException:
        # A socket timeout can win the race with the monitor; report the typed stop instead.
        control.check()
        raise
    finally:
        control.done.set()
        monitor.join()
        control.abort()
        if control.error is not None:
            raise control.error


def get_json(
    base: str,
    path: str,
    *,
    timeout: float = 4.0,
    deadline: float | None = None,
    guard: Callable[[], Any] | None = None,
) -> Any:
    """GET ``path`` from a loopback base and return the decoded JSON object or array."""
    url = require_loopback_base(base) + path
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    return guarded_http(request, timeout, deadline, guard, accepted_types=(dict, list))


def complete_raw(
    base: str,
    body: Mapping[str, Any],
    *,
    timeout: float = 300.0,
    path: str = CHAT_PATH,
    deadline: float | None = None,
    guard: Callable[[], Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """POST a chat-completion body to a loopback provider and return the decoded object.

    Deliberately dumb: it sends a payload and returns what came back. Interpretation (empty
    content, tool calls, usage) belongs to the caller, through ``completion_message``.
    """
    url = require_loopback_base(base) + path
    request = urllib.request.Request(
        url,
        data=json.dumps(dict(body), allow_nan=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            **(headers or {}),
        },
    )
    return guarded_http(request, timeout, deadline, guard)


def request_defaults(thinking: bool = False) -> dict[str, Any]:
    """Body knobs every request to a llama-server style provider needs, in one place.

    Reasoning defaults off because it multiplies token cost; it is a per-call choice. Keeping the
    dict here matters for a second reason: a caller that forgets it gets a working but mute agent.
    """
    return {
        "temperature": 0.3,
        "stream": False,
        # Local providers are long-lived and prompt-prefix reuse is a measured latency win. It
        # keeps provider-internal state only; it is not memory and grants no authority.
        "cache_prompt": True,
        "chat_template_kwargs": {"enable_thinking": bool(thinking)},
    }


def _leaf(model: str) -> str:
    """The last path component of a model id; directories are not identity."""
    return re.split(r"[\\/]", model.strip())[-1]


def require_response_model_identity(
    expected: str, payload: Mapping[str, Any], label: str = ""
) -> None:
    """Bind a response to the model the lane expects, comparing the final file name only.

    A path is allowed in the response's ``model`` field, but host directories are not identity,
    so only the last component is compared. An empty ``expected`` skips the check, which suits a
    development server; a configured lane fails closed when the response omits the model.

    Raises:
        ModelIdentityError: If the model is missing or differs.
    """
    wanted = (expected or "").strip()
    if not wanted:
        return
    observed_raw = payload.get("model")
    if not isinstance(observed_raw, str) or not observed_raw.strip():
        raise ModelIdentityError("response-model-missing", f"lane {label or '?'}")
    observed = _leaf(observed_raw)
    if observed != wanted:
        raise ModelIdentityError(
            "response-model-mismatch", f"lane {label or '?'} expected {wanted!r}, got {observed!r}"
        )


def normalise_tool_call(value: Any, *, require_id: bool) -> dict[str, Any]:
    """Validate one OpenAI-style function call and return it in canonical form.

    Raises:
        AgentRuntimeError: If the call is malformed, its arguments are not a JSON object, or a
            required id is missing.
    """
    if not isinstance(value, Mapping):
        raise AgentRuntimeError("tool-call-malformed")
    raw_id = value.get("id")
    if require_id and (not isinstance(raw_id, str) or not raw_id.strip()):
        raise AgentRuntimeError("tool-call-id-invalid")
    call_id = bounded_text(str(raw_id or uuid.uuid4().hex), field="tool call id", maximum=256)
    if value.get("type", "function") != "function":
        raise AgentRuntimeError("tool-call-type-invalid")
    function = value.get("function")
    if not isinstance(function, Mapping):
        raise AgentRuntimeError("tool-call-lacks-function")
    name = bounded_text(function.get("name"), field="tool name", maximum=128)
    arguments_text = bounded_text(
        function.get("arguments") or "{}", field="tool arguments", maximum=MAX_TOOL_ARGUMENT_CHARS
    )
    try:
        arguments = strict_json(arguments_text)
    except (ValueError, RecursionError) as exc:
        raise AgentRuntimeError("tool-arguments-invalid-json") from exc
    if not isinstance(arguments, Mapping):
        raise AgentRuntimeError("tool-arguments-must-be-an-object")
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, sort_keys=True)},
    }


def completion_message(
    response: Any, *, require_finish: bool, allow_empty_stop: bool = False
) -> Mapping[str, Any]:
    """Admit a whole model completion before its content can propose an effect.

    Real transports require an explicit terminal reason. An in-process fake may omit it, and an
    explicit null or unknown reason always fails.

    Raises:
        AgentRuntimeError: If the completion is not exactly one finished assistant message.
    """
    if not isinstance(response, Mapping):
        raise AgentRuntimeError("completion-not-an-object")
    choices = response.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], Mapping):
        raise AgentRuntimeError("completion-needs-exactly-one-choice")
    choice = choices[0]
    message = choice.get("message")
    if not isinstance(message, Mapping):
        raise AgentRuntimeError("completion-lacks-a-message")
    if message.get("role", "assistant") != "assistant":
        raise AgentRuntimeError("completion-role-invalid")
    content = message.get("content")
    if content is not None and not isinstance(content, str):
        raise AgentRuntimeError("completion-content-must-be-text-or-null")
    if "function_call" in message:
        raise AgentRuntimeError("completion-legacy-function-call-unsupported")
    calls = message.get("tool_calls")
    if calls is not None and not isinstance(calls, list):
        raise AgentRuntimeError("completion-tool-calls-must-be-a-list")
    if "finish_reason" not in choice and not require_finish:
        if not calls and not (content or "").strip():
            raise AgentRuntimeError("completion-is-empty")
        return message
    finish = choice.get("finish_reason")
    if finish not in ("stop", "tool_calls"):
        raise AgentRuntimeError("completion-terminal-reason-missing-or-incomplete")
    if finish == "tool_calls":
        if not calls:
            raise AgentRuntimeError("completion-tool-calls-without-envelope")
        seen: set[str] = set()
        for call in calls:
            normalised = normalise_tool_call(call, require_id=True)
            if normalised["id"] in seen:
                raise AgentRuntimeError("completion-repeats-a-tool-id")
            seen.add(normalised["id"])
    else:
        if calls:
            raise AgentRuntimeError("completion-stop-contains-tool-calls")
        if not (content or "").strip() and not allow_empty_stop:
            raise AgentRuntimeError("completion-is-empty")
    return message


class ChatTransport(Protocol):
    """Anything that can answer a chat payload. Fakes in tests implement exactly this.

    ``options`` carries ``deadline`` and ``guard`` for transports that enforce them; a fake that
    does not can ignore them.
    """

    def complete(
        self, payload: Mapping[str, Any], *, timeout: float, **options: Any
    ) -> Mapping[str, Any]:
        """Return a chat-completion object for ``payload``."""
        ...


class OpenAICompatibleTransport:
    """A chat transport for an OpenAI-compatible provider on loopback.

    Args:
        base: ``http://127.0.0.1:<port>``. Refused at construction if it is anything else.
        expected_model: When set, the response must name this model (file name compared).
        request_defaults: Body fields applied under every payload.
        api_key: Sent as a bearer token if the provider needs one. Never logged or stored.
        label: Lane name used in error messages.
    """

    def __init__(
        self,
        base: str,
        *,
        expected_model: str = "",
        request_defaults: Mapping[str, Any] | None = None,
        api_key: str | None = None,
        label: str = "",
    ) -> None:
        self.base = require_loopback_base(base)
        self.expected_model = expected_model
        self.request_defaults = dict(request_defaults or {})
        self.api_key = api_key
        self.label = label

    def complete(
        self,
        payload: Mapping[str, Any],
        *,
        timeout: float,
        deadline: float | None = None,
        guard: Callable[[], Any] | None = None,
    ) -> Mapping[str, Any]:
        """Send ``payload`` and return the admitted completion object.

        Raises:
            AgentRuntimeError: If the transport fails or the completion is not admissible.
            ModelIdentityError: If the response names a different model than expected.
        """
        body = {**self.request_defaults, **payload}
        headers = {"Authorization": "Bearer " + self.api_key} if self.api_key else None
        if deadline is not None:
            deadline = min(deadline, time.monotonic() + timeout)
        try:
            value = complete_raw(
                self.base, body, timeout=timeout, deadline=deadline, guard=guard, headers=headers
            )
        except (AlcorError, TimeoutError):
            raise
        except Exception as exc:
            raise AgentRuntimeError("provider-request-failed", type(exc).__name__) from exc
        if self.expected_model:
            # A pinned lane fails closed when the response omits or changes the model.
            require_response_model_identity(self.expected_model, value, self.label)
        else:
            # An unpinned development server must at least name the model that was asked for.
            requested, observed = body.get("model"), value.get("model")
            if not isinstance(observed, str) or not observed.strip():
                raise AgentRuntimeError("response-model-missing")
            if not isinstance(requested, str) or _leaf(observed) != _leaf(requested):
                raise AgentRuntimeError("response-model-mismatch")
        completion_message(value, require_finish=True)
        return value


class ReceiptingTransport:
    """Wraps any transport so every model call leaves a receipt.

    The receipt holds hashes, sizes and the provider's reported usage, never the prompt or the
    answer. If the receipt cannot be written the answer is discarded, because a model call the
    gate cannot account for is not one it can stand behind.

    Args:
        inner: The transport that makes the call.
        receipts: The log to write to.
        lane: Lane name recorded in the receipt.
    """

    def __init__(self, inner: ChatTransport, receipts: ReceiptLog, *, lane: str = "") -> None:
        self.inner = inner
        self.receipts = receipts
        self.lane = lane

    def complete(
        self, payload: Mapping[str, Any], *, timeout: float, **options: Any
    ) -> Mapping[str, Any]:
        """Call the inner transport and append a ``model.call`` receipt."""
        started = time.monotonic()
        response = self.inner.complete(payload, timeout=timeout, **options)
        choices = response.get("choices") or [{}]
        self.receipts.append(
            "model.call",
            {
                "lane": self.lane,
                "model": str(response.get("model") or ""),
                "message_count": len(payload.get("messages") or ()),
                "request_sha256": sha256_hex(dict(payload)),
                "response_sha256": sha256_hex(dict(response)),
                "finish_reason": str(choices[0].get("finish_reason") or ""),
                "usage": dict(response.get("usage") or {}),
                "elapsed_ms": int((time.monotonic() - started) * 1000),
                "task_verified": False,
            },
        )
        return response
