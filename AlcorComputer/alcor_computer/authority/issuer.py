"""The read-lane authority: scope issuer, result signer and registry of completed chains.

Why the mediator needs this. A click may only be staged if it follows an observation that typed
code actually made inside a granted scope. This class issues the scope, signs the finished
``prepared -> search -> read -> completed`` chain, and remembers which outer read-chains it has
registered, so the mediator can ask "did the lane really produce this?".

Trust model, stated plainly
---------------------------
Tags are HMAC-SHA256 values. By default the key is derived from the *public* contract hash
(``ReadLaneAuthority.source_bound``), so anyone who holds this source can recompute it. A tag
therefore works as an **integrity check**: it detects tampering and forgeries made by code or a
model that does not run this module. It is **not authentication** of who produced a value. Pass
a random 32-byte key to ``ReadLaneAuthority(key)`` if tags must be unforgeable by other code in
the same deployment.

What keeps an operator from granting itself access is structural. Scopes are issued by typed
code, operator output is data checked against closed shapes, and the registry of completed
chains lives in this object's memory, so only code that holds the instance, after the typed lane
has finished, can add to it. A hash file or an environment variable cannot.
"""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping, Sequence
from typing import Any, TypeVar

from ..contracts import canonical_bytes, sha256_hex
from .contract import (
    _OPAQUE_RE,
    _SHA256_RE,
    ALLOWED_VERBS,
    CONTRACT_SHA256,
    CONTRACT_SHA256_PREFIX,
    MAX_GLOBS,
    MAX_SCOPE_BYTES,
    MAX_SCOPE_RESULTS,
    SCOPE_SCHEMA,
    AuthorityError,
    _bounded_int,
    _closed_mapping,
    _normalize_glob,
)
from .result_checks import validate_computer_chain, validate_result_components
from .values import BoundedObservation, ReadLaneResult, ReadScopeToken

_Authority = TypeVar("_Authority", bound="ReadLaneAuthority")

_SCOPE_FIELDS = (
    "schema",
    "scope_id",
    "contract_sha256_prefix",
    "path_globs",
    "verbs",
    "max_results",
    "max_bytes",
    "authentication_tag",
)


class ReadLaneAuthority:
    """Process-local scope issuer, result signer and completed-chain registry.

    The key is passed in (tests, deployments with a real secret) or derived from the reviewed
    contract by ``source_bound``. It is never serialised into a token or a receipt.

    Every ``verify_*`` method returns False on malformed input instead of raising, because a
    verifier that can be crashed by bad input can be bypassed by crashing it.

    Args:
        key: HMAC key, at least 32 bytes.

    Raises:
        ValueError: If the key is not ``bytes`` or is shorter than 32 bytes.
    """

    def __init__(self, key: bytes) -> None:
        if not isinstance(key, bytes) or len(key) < 32:
            raise ValueError("authority_key_invalid")
        self._key = bytes(key)
        # chain digest -> (canonical chain bytes, registry tag, result tag)
        self._computer_chains: dict[str, tuple[bytes, str, str]] = {}

    @classmethod
    def source_bound(cls: type[_Authority]) -> _Authority:
        """Build an authority whose key is derived from the public contract hash.

        Two processes running the same source derive the same key, which makes issued scopes
        reproducible. It also means the key is not a secret; see the module docstring.
        """
        material = ("alcor.authority.readlane.source-authority.v1:" + CONTRACT_SHA256).encode(
            "ascii"
        )
        return cls(hashlib.sha256(material).digest())

    def _tag(self, label: str, value: Any) -> str:
        """HMAC over ``label``, a NUL separator and the canonical JSON of ``value``.

        The label keeps tags for different purposes (scope, result, registry) from being
        interchangeable even when the underlying values happen to be equal.
        """
        payload = label.encode("ascii") + b"\x00" + canonical_bytes(value)
        return hmac.new(self._key, payload, hashlib.sha256).hexdigest()

    def issue_scope(
        self,
        path_globs: Sequence[str],
        verbs: Sequence[str],
        max_results: int,
        max_bytes: int,
    ) -> ReadScopeToken:
        """Issue a tagged read scope.

        Globs and verbs are sorted and de-duplicated, so the same grant always yields the same
        token regardless of how the caller ordered it.

        Args:
            path_globs: One to ``MAX_GLOBS`` relative globs. Absolute, parent-relative and
                negated patterns are refused.
            verbs: Any non-empty subset of ``read`` and ``search``.
            max_results: Per-action result cap, 1 to ``MAX_SCOPE_RESULTS``.
            max_bytes: Per-action byte cap, 1 to ``MAX_SCOPE_BYTES``.

        Returns:
            The signed token.

        Raises:
            AuthorityError: ``invalid_scope``, ``invalid_path``, ``verb_not_allowed`` or
                ``invalid_cap``.
        """
        if (
            not isinstance(path_globs, (list, tuple))
            or not path_globs
            or len(path_globs) > MAX_GLOBS
        ):
            raise AuthorityError("invalid_scope")
        normalized_globs = tuple(sorted({_normalize_glob(item) for item in path_globs}))
        normalized_verbs = tuple(sorted(set(verbs)))
        if not normalized_verbs or any(verb not in ALLOWED_VERBS for verb in normalized_verbs):
            raise AuthorityError("verb_not_allowed")
        result_cap = _bounded_int(max_results, 1, MAX_SCOPE_RESULTS)
        byte_cap = _bounded_int(max_bytes, 1, MAX_SCOPE_BYTES)
        seed = {
            "schema": SCOPE_SCHEMA,
            "contract_sha256_prefix": CONTRACT_SHA256_PREFIX,
            "path_globs": list(normalized_globs),
            "verbs": list(normalized_verbs),
            "max_results": result_cap,
            "max_bytes": byte_cap,
        }
        scope_id = sha256_hex(seed)[:24]
        body = {**seed, "scope_id": scope_id}
        return ReadScopeToken(
            schema=SCOPE_SCHEMA,
            scope_id=scope_id,
            contract_sha256_prefix=CONTRACT_SHA256_PREFIX,
            path_globs=normalized_globs,
            verbs=normalized_verbs,
            max_results=result_cap,
            max_bytes=byte_cap,
            authentication_tag=self._tag("scope", body),
        )

    def validate_scope(self, value: Any) -> ReadScopeToken:
        """Check a token, or a dict claiming to be one, and return it as a ``ReadScopeToken``.

        Checks run cheapest first: shape, schema and contract, canonical form (sorted and
        de-duplicated), caps, then the content-derived ``scope_id`` and finally the tag.
        Anything unexpected that goes wrong while checking is reported as ``invalid_scope``.

        Args:
            value: A ``ReadScopeToken`` or its ``to_dict()`` form.

        Returns:
            The validated token.

        Raises:
            AuthorityError: With the reason code of the first check that failed, for example
                ``contract_mismatch`` or ``scope_authentication_failed``.
        """
        try:
            return self._check_scope(value)
        except AuthorityError:
            raise
        except Exception as exc:
            raise AuthorityError("invalid_scope") from exc

    def _check_scope(self, value: Any) -> ReadScopeToken:
        if isinstance(value, ReadScopeToken):
            token = value
        else:
            mapping = _closed_mapping(value, _SCOPE_FIELDS)
            globs_value = mapping["path_globs"]
            verbs_value = mapping["verbs"]
            if not isinstance(globs_value, list) or not isinstance(verbs_value, list):
                raise AuthorityError("invalid_scope")
            token = ReadScopeToken(
                schema=mapping["schema"],
                scope_id=mapping["scope_id"],
                contract_sha256_prefix=mapping["contract_sha256_prefix"],
                path_globs=tuple(globs_value),
                verbs=tuple(verbs_value),
                max_results=mapping["max_results"],
                max_bytes=mapping["max_bytes"],
                authentication_tag=mapping["authentication_tag"],
            )
        if token.schema != SCOPE_SCHEMA:
            raise AuthorityError("invalid_scope")
        if token.contract_sha256_prefix != CONTRACT_SHA256_PREFIX:
            raise AuthorityError("contract_mismatch")
        if not isinstance(token.scope_id, str) or _OPAQUE_RE.fullmatch(token.scope_id) is None:
            raise AuthorityError("invalid_scope")
        if not token.path_globs or len(token.path_globs) > MAX_GLOBS:
            raise AuthorityError("invalid_scope")
        normalized_globs = tuple(sorted({_normalize_glob(item) for item in token.path_globs}))
        normalized_verbs = tuple(sorted(set(token.verbs)))
        # A token must already be in canonical form; otherwise two spellings of one scope
        # could carry different tags.
        if normalized_globs != token.path_globs or normalized_verbs != token.verbs:
            raise AuthorityError("invalid_scope")
        if not normalized_verbs or any(verb not in ALLOWED_VERBS for verb in normalized_verbs):
            raise AuthorityError("verb_not_allowed")
        _bounded_int(token.max_results, 1, MAX_SCOPE_RESULTS)
        _bounded_int(token.max_bytes, 1, MAX_SCOPE_BYTES)
        if (
            not isinstance(token.authentication_tag, str)
            or _SHA256_RE.fullmatch(token.authentication_tag) is None
        ):
            raise AuthorityError("scope_authentication_failed")
        seed = {
            "schema": SCOPE_SCHEMA,
            "contract_sha256_prefix": CONTRACT_SHA256_PREFIX,
            "path_globs": list(normalized_globs),
            "verbs": list(normalized_verbs),
            "max_results": token.max_results,
            "max_bytes": token.max_bytes,
        }
        if token.scope_id != sha256_hex(seed)[:24]:
            raise AuthorityError("scope_authentication_failed")
        expected = self._tag("scope", token.body())
        if not hmac.compare_digest(expected, token.authentication_tag):
            raise AuthorityError("scope_authentication_failed")
        return token

    def _result_tag(
        self,
        token: ReadScopeToken,
        receipts: Sequence[Mapping[str, Any]],
        observations: Sequence[BoundedObservation],
    ) -> str:
        """Tag over hashes of the token, each receipt and each observation body."""
        payload = {
            "scope_token_sha256": sha256_hex(token.to_dict()),
            "receipt_sha256": [sha256_hex(item) for item in receipts],
            "observation_sha256": [
                hashlib.sha256(item.body_truncated_to_cap.encode("utf-8")).hexdigest()
                for item in observations
            ],
        }
        return self._tag("result", payload)

    def authorize_result(
        self,
        token: ReadScopeToken,
        receipts: Sequence[Mapping[str, Any]],
        observations: Sequence[BoundedObservation],
    ) -> ReadLaneResult:
        """Sign a completed chain after checking its receipts and observations field by field.

        The tag covers a hash of each receipt and of each observation body, so changing any of
        them afterwards makes ``verify_result`` fail. A chain that is mis-ordered, has extra
        fields or whose counts disagree with its observations is never signed.

        Args:
            token: The scope the chain ran under; re-validated here.
            receipts: The chain's four receipts, in protocol order.
            observations: The two bounded observations, search first.

        Returns:
            The signed result.

        Raises:
            AuthorityError: ``readlane_result_invalid`` if the components do not form one
                coherent chain, or a scope error from ``validate_scope``.
        """
        validated = self.validate_scope(token)
        receipt_tuple, observation_tuple = validate_result_components(
            validated, receipts, observations
        )
        return ReadLaneResult(
            token=validated,
            receipts=receipt_tuple,
            observations=observation_tuple,
            authorization_tag=self._result_tag(validated, receipt_tuple, observation_tuple),
        )

    def verify_result(self, result: Any) -> bool:
        """Return True only for an untampered, well-ordered, all-green result.

        The components are re-validated field by field (four receipts in ``READ_CHAIN_PHASES``
        order, two observations that agree with them) and the tag is recomputed. Reordering or
        dropping a receipt therefore fails before the tag is even compared.

        Args:
            result: Anything; values that are not a ``ReadLaneResult`` return False.

        Returns:
            Whether the result is authentic and well-formed.
        """
        if not isinstance(result, ReadLaneResult):
            return False
        try:
            token = self.validate_scope(result.token)
            receipts, observations = validate_result_components(
                token, result.receipts, result.observations
            )
            expected = self._result_tag(token, receipts, observations)
            return isinstance(result.authorization_tag, str) and hmac.compare_digest(
                expected, result.authorization_tag
            )
        except Exception:
            return False

    def authorize_computer_chain(self, result: ReadLaneResult, chain: Mapping[str, Any]) -> str:
        """Register one outer read-chain after the typed lane has completed.

        The outer chain is the record the computer-use mediator receives. It is accepted only
        if it points back at this very result (same scope id, same contract prefix, hashes of
        this result's first receipt and of its full receipt list), has exactly the documented
        fields, a sane validity window and projects to one on-screen candidate. Nothing read
        from a file, an environment variable or an operator claim can populate this registry.

        Args:
            result: A result that passes ``verify_result``.
            chain: The outer chain dict.

        Returns:
            The chain's SHA-256 digest, which is the registry key.

        Raises:
            AuthorityError: ``readlane_result_unauthenticated`` or ``readlane_chain_mismatch``.
        """
        if not self.verify_result(result):
            raise AuthorityError("readlane_result_unauthenticated")
        chain_digest = validate_computer_chain(result, chain)
        registry_tag = self._tag(
            "computer-chain",
            {
                "chain_sha256": chain_digest,
                "result_authorization_tag": result.authorization_tag,
            },
        )
        self._computer_chains[chain_digest] = (
            canonical_bytes(chain),
            registry_tag,
            result.authorization_tag,
        )
        return chain_digest

    def verify_computer_chain(self, chain: Mapping[str, Any], chain_digest: str) -> bool:
        """Return True if ``chain`` was registered by ``authorize_computer_chain``.

        Args:
            chain: The outer chain dict.
            chain_digest: The digest the caller believes it has; it must match the dict.

        Returns:
            Whether this exact chain is in the registry with an intact tag. Never raises.
        """
        try:
            if (
                not isinstance(chain, dict)
                or not isinstance(chain_digest, str)
                or _SHA256_RE.fullmatch(chain_digest) is None
            ):
                return False
            if sha256_hex(chain) != chain_digest:
                return False
            stored = self._computer_chains.get(chain_digest)
            if stored is None or stored[0] != canonical_bytes(chain):
                return False
            expected = self._tag(
                "computer-chain",
                {
                    "chain_sha256": chain_digest,
                    "result_authorization_tag": stored[2],
                },
            )
            return hmac.compare_digest(expected, stored[1])
        except Exception:
            return False


_DEFAULT_AUTHORITY: ReadLaneAuthority | None = None


def default_authority() -> ReadLaneAuthority:
    """Return the shared source-bound authority for this process, creating it on first use.

    Sharing one instance matters: the completed-chain registry is per instance, so the lane that
    registers a chain and the mediator that later verifies it must use the same object.
    """
    global _DEFAULT_AUTHORITY
    if _DEFAULT_AUTHORITY is None:
        _DEFAULT_AUTHORITY = ReadLaneAuthority.source_bound()
    return _DEFAULT_AUTHORITY
