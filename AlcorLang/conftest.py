"""Pytest configuration: make ``import alcorlang`` work from a plain checkout.

The package lives in ``AlcorLang/alcorlang`` (next to ``tests/`` and ``demo/``), so this folder
has to be on ``sys.path`` for the tests to import it without installing anything.
"""

from __future__ import annotations

import sys
from pathlib import Path

_COMPONENT_ROOT = str(Path(__file__).resolve().parent)
if _COMPONENT_ROOT not in sys.path:
    sys.path.insert(0, _COMPONENT_ROOT)
