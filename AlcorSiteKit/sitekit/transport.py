"""How a release reaches staging.

``Transport`` is the seam between sitekit and wherever staging lives. ``DirectoryTransport``
deploys into a host directory (a local folder, a mounted share, or the folder a web server points
at) through the same verified swap production uses. For anything else (rsync, object storage, a
hosting API) write a class with a ``push`` method and name it in the config as
``"transport": "package.module:ClassName"``; it is constructed with the resolved ``Config``.

Production has no transport on purpose. The operator never pushes to production: it appends to the
pointer log and the controller on the host does the rest.
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Protocol

from .config import Config, ConfigError
from .deploy import apply_release
from .release import Release


class Transport(Protocol):
    """Puts a verified release on staging."""

    def push(self, release: Release, files_root: Path) -> None:
        """Make ``release`` (whose file contents sit under ``files_root``) live on staging."""
        ...


class DirectoryTransport:
    """Deploys into a host directory laid out as ``deploy.py`` describes."""

    def __init__(self, host_dir: Path) -> None:
        self.host_dir = host_dir

    def push(self, release: Release, files_root: Path) -> None:
        """Verify and swap the release in; raises ``DeployError`` and restores on failure."""
        apply_release(self.host_dir, release, files_root)


def load_transport(cfg: Config) -> Transport:
    """Build the transport named by ``cfg.transport``.

    Raises:
        ConfigError: if the name is neither ``directory`` nor an importable ``module:Class``.
    """
    if cfg.transport == "directory":
        return DirectoryTransport(cfg.staging_dir)
    module_name, _, class_name = cfg.transport.partition(":")
    if not module_name or not class_name:
        raise ConfigError(f"transport must be 'directory' or 'module:Class', got {cfg.transport!r}")
    try:
        cls = getattr(importlib.import_module(module_name), class_name)
    except (ImportError, AttributeError) as error:
        raise ConfigError(f"cannot load transport {cfg.transport!r}: {error}") from error
    return cls(cfg)
