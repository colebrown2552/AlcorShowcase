"""alcor_computer: a contract-bound computer-use mediator with real macOS and Windows backends.

Three parts that fit together:

* **Mediator** (``ComputerUseMediator``): validates and stages one click proposal that is bound,
  by hash, to an observation the read-lane authority (``alcor_computer.authority``) really
  produced. It never performs input.
* **App control** (``AppController``): a bounded session for one explicit application. Input needs
  an opt-in, an owner-written short-lived grant, a fresh one-use observation and a second identity
  check in the backend; every effect leaves a durable receipt first.
* **Runtime and backends** (``Computer`` plus ``backends``): one dry-run-by-default interface over
  macOS and Windows implementations, and a reflex executor for bounded multi-step subtasks.
"""

from .app_control import AppControlError, AppControlGrant, AppController
from .contracts import (
    COMPUTER_BUNDLE_ARM,
    READ_CHAIN_ARM,
    STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX,
    UNION_SCHEMA_SHA256_PREFIX,
)
from .mediator import ComputerUseMediator, ContractError, ReplayLedger
from .reflex_executor import (
    ActionKind,
    ActionRecord,
    AppControllerElementBackend,
    Decision,
    DesktopElement,
    DesktopExecutor,
    DesktopSnapshot,
    ExecutionResult,
    ExecutorConfig,
    ReflexError,
    Subtask,
    TerminalKind,
    VerificationDecision,
    VerificationKind,
    legal_action_space,
    materialize_action,
)
from .runtime import ArmSession, Computer, RuntimeErrorCode

__all__ = [
    "COMPUTER_BUNDLE_ARM",
    "READ_CHAIN_ARM",
    "STRICT_MEDIATOR_CONTRACT_SHA256_PREFIX",
    "UNION_SCHEMA_SHA256_PREFIX",
    "ActionKind",
    "ActionRecord",
    "AppControlError",
    "AppControlGrant",
    "AppController",
    "AppControllerElementBackend",
    "ArmSession",
    "Computer",
    "ComputerUseMediator",
    "ContractError",
    "Decision",
    "DesktopElement",
    "DesktopExecutor",
    "DesktopSnapshot",
    "ExecutionResult",
    "ExecutorConfig",
    "ReflexError",
    "ReplayLedger",
    "RuntimeErrorCode",
    "Subtask",
    "TerminalKind",
    "VerificationDecision",
    "VerificationKind",
    "legal_action_space",
    "materialize_action",
]
