"""No-install entry point: run ``python continuity.py <verb> ...`` from a fresh checkout.

It puts the sibling ``src`` directory on the import path, so the package works without
``pip install``. After ``pip install -e .`` the ``continuity`` command does the same thing.
"""

from __future__ import annotations

import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parent / "src"
if str(SOURCE) not in sys.path:
    sys.path.insert(0, str(SOURCE))

from continuity_core.cli import main  # noqa: E402

raise SystemExit(main())
