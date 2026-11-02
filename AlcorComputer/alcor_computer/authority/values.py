"""Typed values and hermetic stand-ins for the read lane.

The dataclasses here are what crosses a trust boundary: a scope token going in, bounded
observations and an authenticated result coming out. ``FakeObservationAdapter`` and
``SingleTurnStubOperator`` let the whole lane run with no model and no filesystem.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .contract import AuthorityError


@dataclass(frozen=True)
class ReadScopeToken:
    """A signed grant of read access: which paths, which verbs, and how much.

    Tokens are immutable. ``authentication_tag`` is a keyed hash over every other field (see
    ``ReadLaneAuthority`` for what that does and does not prove).

    Attributes:
        schema: Token schema id.
        scope_id: Content-derived id; two identical scopes share it.
        contract_sha256_prefix: Prefix of the contract hash the token was issued under.
        path_globs: Sorted, de-duplicated relative globs the holder may touch.
        verbs: Sorted subset of ``read`` and ``search``.
        max_results: Cap on results per action.
        max_bytes: Cap on bytes per action.
        authentication_tag: Hex keyed-hash tag over the other fields.
    """

    schema: str
    scope_id: str
    contract_sha256_prefix: str
    path_globs: tuple[str, ...]
    verbs: tuple[str, ...]
    max_results: int
    max_bytes: int
    authentication_tag: str

    def body(self) -> dict[str, Any]:
        """Return the fields covered by the tag, as plain JSON types."""
        return {
            "schema": self.schema,
            "scope_id": self.scope_id,
            "contract_sha256_prefix": self.contract_sha256_prefix,
            "path_globs": list(self.path_globs),
            "verbs": list(self.verbs),
            "max_results": self.max_results,
            "max_bytes": self.max_bytes,
        }

    def to_dict(self) -> dict[str, Any]:
        """Return the token as a JSON-ready dict, tag included."""
        value = self.body()
        value["authentication_tag"] = self.authentication_tag
        return value


@dataclass(frozen=True)
class BoundedObservation:
    """What an adapter returned, cut down to the caps and fingerprinted.

    Attributes:
        result_count: Number of results the adapter produced.
        content_sha256_prefix: Hash prefix of the full (untruncated) content.
        body_truncated_to_cap: The text, cut to the byte cap. Never placed in a receipt.
        body_was_truncated: True if the cap removed anything.
    """

    result_count: int
    content_sha256_prefix: str
    body_truncated_to_cap: str
    body_was_truncated: bool

    def receipt_fields(self) -> dict[str, Any]:
        """Return the receipt-safe view: counts, hash prefix and flags, no text."""
        return {
            "result_count": self.result_count,
            "content_sha256_prefix": self.content_sha256_prefix,
            "body_truncated_to_cap": True,
            "body_was_truncated": self.body_was_truncated,
        }


@dataclass(frozen=True)
class ReadLaneResult:
    """A completed chain together with the tag that vouches for it.

    Attributes:
        token: The scope the chain ran under.
        receipts: The four receipts, in protocol order.
        observations: The search and read observations, in that order.
        authorization_tag: Keyed-hash tag over the token, receipts and observations.
    """

    token: ReadScopeToken
    receipts: tuple[Mapping[str, Any], ...]
    observations: tuple[BoundedObservation, ...]
    authorization_tag: str


@dataclass(frozen=True)
class LaneRun:
    """Outcome of ``ReadLane.run``.

    Attributes:
        ok: True only if all four phases completed.
        receipts: Four receipts on success, a single rejection receipt otherwise.
        result: The authenticated result on success, else None.
    """

    ok: bool
    receipts: tuple[Mapping[str, Any], ...]
    result: ReadLaneResult | None


class ObservationAdapter(Protocol):
    """Transport-free contract for whatever actually reads data.

    The lane calls an adapter only after the operator's request has passed typed validation, so
    an adapter never sees an out-of-scope path or an oversize cap.
    """

    def search(self, path: str, query: str, max_results: int) -> Sequence[str]:
        """Return up to ``max_results`` matching text snippets for ``query`` near ``path``."""
        ...

    def read(self, path: str) -> str:
        """Return the full text stored at ``path``."""
        ...


class FakeObservationAdapter:
    """In-memory adapter over a ``{path: text}`` mapping, used by tests and the demo.

    Attributes:
        calls: The verbs invoked so far (``"search"`` / ``"read"``), in call order.
    """

    def __init__(self, documents: Mapping[str, str]) -> None:
        self._documents = dict(documents)
        self.calls: list[str] = []

    def search(self, path: str, query: str, max_results: int) -> Sequence[str]:
        """Case-insensitive substring search over documents in the same directory as ``path``."""
        self.calls.append("search")
        needle = query.casefold()
        directory = path.rsplit("/", 1)[0] + "/"
        matches = [
            body
            for document_path, body in sorted(self._documents.items())
            if (document_path == path or document_path.startswith(directory))
            and needle in body.casefold()
        ]
        return matches[:max_results]

    def read(self, path: str) -> str:
        """Return the stored text, or raise ``adapter_not_found``."""
        self.calls.append("read")
        if path not in self._documents:
            raise AuthorityError("adapter_not_found")
        return self._documents[path]


class SingleTurnStubOperator:
    """A scripted stand-in for an LLM operator that allows exactly one turn.

    The canned output is deep-copied on the way in and on the way out, so neither the caller nor
    the lane can alter it after construction. A second call raises, which is how tests prove the
    lane never asks the operator twice.

    Attributes:
        calls: How many times the operator has been invoked.
    """

    def __init__(self, output: Mapping[str, Any]) -> None:
        self._output = json.loads(json.dumps(output))
        self.calls = 0

    def __call__(self, task_input: Mapping[str, Any]) -> Mapping[str, Any]:
        """Return the canned output on the first call; raise on any later call."""
        del task_input
        self.calls += 1
        if self.calls != 1:
            raise AuthorityError("multiple_operator_turns")
        return json.loads(json.dumps(self._output))
