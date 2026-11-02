"""Backends: the platform layer that observes a machine and, when allowed, acts on it.

* ``base``: the ``Backend`` protocol and ``BackendError``.
* ``macos`` / ``windows``: observation-only (macOS) or empty (Windows) defaults for ``Computer``.
* ``macos_app`` / ``windows_app``: explicit single-application backends with a prepare-then-perform
  double identity check, used by ``AppController``.
* ``windows_win32``: the ``ctypes`` Win32 adapter behind ``windows_app`` and ``alcor_click``.
* ``windows_private``: read-only NTFS ACL checks for the controller's private files.

Backends are never chosen by data: the runtime selects one by platform name and the embedding
program injects the app backends explicitly.
"""
