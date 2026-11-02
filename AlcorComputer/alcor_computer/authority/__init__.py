"""Read-lane authority: how a click proposal earns an authenticated observation.

The computer-use mediator only stages a click that follows an observation which typed code made
inside a granted scope. This subpackage is that typed code:

* ``ReadLaneAuthority`` issues a scoped read token and signs the finished chain;
* ``ReadLane`` runs ``prepared -> search -> read -> completed`` for one single-turn, data-only
  operator, refusing anything outside the scope or the closed operator shape;
* ``FakeObservationAdapter`` and ``SingleTurnStubOperator`` let the lane run with no model and no
  filesystem;
* ``static_check`` (run it with ``python -m alcor_computer.authority.static_check``)
  re-verifies, from source, that the subpackage has no live path.

The tags are an integrity check keyed from the public contract hash, not authentication. See
``issuer`` for the trust model.
"""

from .contract import (
    BASE_RECEIPT_SCHEMA,
    CONTRACT_SHA256,
    CONTRACT_SHA256_PREFIX,
    OPERATOR_OUTPUT_SCHEMA,
    READLANE_SCHEMA,
    TASK_INPUT_SCHEMA,
    AuthorityError,
)
from .issuer import ReadLaneAuthority, default_authority
from .lane import ReadLane
from .values import (
    BoundedObservation,
    FakeObservationAdapter,
    LaneRun,
    ObservationAdapter,
    ReadLaneResult,
    ReadScopeToken,
    SingleTurnStubOperator,
)

__all__ = [
    "BASE_RECEIPT_SCHEMA",
    "CONTRACT_SHA256",
    "CONTRACT_SHA256_PREFIX",
    "OPERATOR_OUTPUT_SCHEMA",
    "READLANE_SCHEMA",
    "TASK_INPUT_SCHEMA",
    "AuthorityError",
    "BoundedObservation",
    "FakeObservationAdapter",
    "LaneRun",
    "ObservationAdapter",
    "ReadLane",
    "ReadLaneAuthority",
    "ReadLaneResult",
    "ReadScopeToken",
    "SingleTurnStubOperator",
    "default_authority",
]
