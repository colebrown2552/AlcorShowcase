"""Source-wired link from the mediator to the read-lane authority.

The mediator never accepts a read-chain because a file, an environment variable or the chain
itself says it is authentic. It asks the authority registry that lives in this process
(``authority.default_authority``), which contains only chains that the typed lane registered
after a completed run.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .authority import CONTRACT_SHA256_PREFIX, default_authority

# The checked-in pin (contracts/alcor_read_scope_binding_v1.json) must equal this value.
READ_SCOPE_CONTRACT_SHA256_PREFIX = CONTRACT_SHA256_PREFIX


def verify_authenticated_read_chain(
    chain: Mapping[str, Any],
    chain_sha256: str,
) -> bool:
    """Return True only if the authority registered exactly this read-chain.

    Args:
        chain: The read-chain dict as received.
        chain_sha256: Its canonical SHA-256 digest.

    Returns:
        Whether ``default_authority()`` holds this chain. Never raises.
    """
    return default_authority().verify_computer_chain(chain, chain_sha256)


__all__ = [
    "READ_SCOPE_CONTRACT_SHA256_PREFIX",
    "verify_authenticated_read_chain",
]
