"""Backends that lower ALCORCORE to other languages: standalone Python and C99.

Both walk the same flat instruction list the interpreter executes, so they cannot drift from it
on control flow.  Python is the parity backend (it must match ``run()`` byte for byte); C is the
bounded-machine backend (``int64`` with overflow traps).
"""

from __future__ import annotations

from .c_backend import lower_c
from .python_backend import lower_python

__all__ = ["lower_c", "lower_python"]
