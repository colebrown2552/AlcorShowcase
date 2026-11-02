"""Read-only Windows owner/DACL checks for the app controller's private files.

POSIX mode bits say nothing about NTFS privacy, so on Windows the grant file, the receipt file
and their directory are judged by their real security descriptor. These functions only *read*
ACLs; no ACL is ever changed here.

A file counts as private when the current user owns it and every effective "allow" entry in its
DACL belongs to that user, SYSTEM or the built-in Administrators group. Reparse points
(symlinks, junctions) and a missing DACL (which grants everyone access) are refused.
"""

from __future__ import annotations

import ctypes as C
import os
from collections.abc import Callable
from ctypes import wintypes as W
from pathlib import Path
from typing import Any

SYSTEM_SID = "S-1-5-18"
ADMINISTRATORS_SID = "S-1-5-32-544"
# "OWNER RIGHTS": an entry that applies to whoever owns the object. Python's own tempfile module
# uses it when it creates a 0o700 directory, so it has to be understood as "the owner".
OWNER_RIGHTS_SID = "S-1-3-4"
_ACCESS_ALLOWED = 0
_ACCESS_DENIED = 1
_INHERIT_ONLY_ACE = 0x08
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400

Entry = tuple[int, int, str]


def private_acl(
    owner: str, current: str, entries: list[Entry], *, dacl_present: bool = True
) -> bool:
    """Decide whether an ACL makes an object private to ``current``.

    Args:
        owner: SID string of the object's owner.
        current: SID string of the current user.
        entries: ``(ace_type, access_mask, sid)`` triples. Only allow (0) and deny (1) entries
            are understood; anything else fails closed.
        dacl_present: False for a null DACL, which grants everyone access.

    Returns:
        True only if the current user owns the object, at least one allow entry names that
        user, and every allow entry names the user, SYSTEM or Administrators.
    """
    if not dacl_present or owner != current or not entries:
        return False
    allowed = {current, SYSTEM_SID, ADMINISTRATORS_SID}
    saw_current = False
    for kind, mask, sid in entries:
        if kind not in (_ACCESS_ALLOWED, _ACCESS_DENIED):
            # Object and callback ACEs have semantics this check does not model.
            return False
        if sid == OWNER_RIGHTS_SID:
            sid = owner
        if kind == _ACCESS_ALLOWED and mask:
            if sid not in allowed:
                return False
            saw_current |= sid == current
    return saw_current


def write_protected_acl(
    owner: str, current: str, entries: list[Entry], *, dacl_present: bool = True
) -> bool:
    """Decide whether an ACL lets only trusted principals modify an object.

    Used for map-like data that may be read widely: outsiders may hold read and execute rights
    but nothing that writes or changes the ACL.

    Returns:
        True if the owner is trusted and no untrusted allow entry carries a right beyond read
        and execute.
    """
    trusted = {current, SYSTEM_SID, ADMINISTRATORS_SID}
    if not dacl_present or owner not in trusted or not entries:
        return False
    # Read data/EA/attributes, execute/traverse, READ_CONTROL, SYNCHRONIZE, GENERIC_READ and
    # GENERIC_EXECUTE. Anything else granted to an outsider refuses.
    readonly = 0x001200A9 | 0x80000000 | 0x20000000
    saw_trusted = False
    for kind, mask, sid in entries:
        # OWNER RIGHTS denotes this object's actual owner, which was checked above.
        if sid == OWNER_RIGHTS_SID:
            sid = owner
        if kind not in (_ACCESS_ALLOWED, _ACCESS_DENIED) or type(mask) is not int:
            return False
        if mask < 0 or mask > 0xFFFFFFFF:
            return False
        if kind == _ACCESS_ALLOWED and mask:
            if sid not in trusted and mask & ~readonly:
                return False
            saw_trusted |= sid in trusted
    return saw_trusted


def _check_acl(
    path: Path,
    *,
    descriptor: int | None = None,
    checker: Callable[..., bool] = private_acl,
) -> bool:
    """Read the owner and DACL of ``path`` (or of an open ``descriptor``) and apply ``checker``.

    Every failure to read, and every surprising structure, returns False.
    """
    if os.name != "nt":
        return False
    try:
        if getattr(Path(path).lstat(), "st_file_attributes", 0) & _FILE_ATTRIBUTE_REPARSE_POINT:
            return False
    except OSError:
        return False
    import msvcrt

    kernel = C.WinDLL("kernel32", use_last_error=True)
    advapi = C.WinDLL("advapi32", use_last_error=True)
    pointer = C.c_void_p
    pointer_to_pointer = C.POINTER(pointer)

    def bind(library: Any, name: str, argtypes: list[Any], restype: Any) -> None:
        function = getattr(library, name)
        function.argtypes = argtypes
        function.restype = restype

    bind(kernel, "GetCurrentProcess", [], W.HANDLE)
    bind(kernel, "CloseHandle", [W.HANDLE], W.BOOL)
    bind(kernel, "LocalFree", [pointer], pointer)
    bind(
        kernel,
        "CreateFileW",
        [W.LPCWSTR, W.DWORD, W.DWORD, pointer, W.DWORD, W.DWORD, W.HANDLE],
        W.HANDLE,
    )
    bind(kernel, "GetFileInformationByHandleEx", [W.HANDLE, C.c_int, pointer, W.DWORD], W.BOOL)
    bind(advapi, "OpenProcessToken", [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)], W.BOOL)
    bind(
        advapi,
        "GetTokenInformation",
        [W.HANDLE, C.c_int, pointer, W.DWORD, C.POINTER(W.DWORD)],
        W.BOOL,
    )
    bind(
        advapi,
        "GetSecurityInfo",
        [
            W.HANDLE,
            C.c_int,
            W.DWORD,
            pointer_to_pointer,
            pointer_to_pointer,
            pointer_to_pointer,
            pointer_to_pointer,
            pointer_to_pointer,
        ],
        W.DWORD,
    )
    bind(advapi, "ConvertSidToStringSidW", [pointer, C.POINTER(W.LPWSTR)], W.BOOL)
    bind(advapi, "GetAce", [pointer, W.DWORD, pointer_to_pointer], W.BOOL)

    def sid_text(sid: Any) -> str:
        text = W.LPWSTR()
        if not sid or not advapi.ConvertSidToStringSidW(sid, C.byref(text)):
            raise OSError("sid unavailable")
        try:
            return str(text.value)
        finally:
            kernel.LocalFree(C.cast(text, pointer))

    class AclHeader(C.Structure):
        _fields_ = (
            ("revision", C.c_ubyte),
            ("sbz", C.c_ubyte),
            ("size", C.c_ushort),
            ("count", C.c_ushort),
            ("sbz2", C.c_ushort),
        )

    token = W.HANDLE()
    own_handle = False
    handle = None
    descriptor_block = pointer()
    try:
        # TOKEN_QUERY, then TokenUser (class 1) to learn who "current" is.
        if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, C.byref(token)):
            return False
        needed = W.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, C.byref(needed))
        if not 0 < needed.value < 65536:
            return False
        buffer = C.create_string_buffer(needed.value)
        if not advapi.GetTokenInformation(token, 1, buffer, len(buffer), C.byref(needed)):
            return False
        current = sid_text(C.cast(buffer, C.POINTER(pointer))[0])
        if descriptor is None:
            # READ_CONTROL only; do not follow reparse points; BACKUP_SEMANTICS opens directories.
            handle = kernel.CreateFileW(
                str(path), 0x20000, 7, None, 3, 0x02000000 | 0x00200000, None
            )
            if not handle or handle == pointer(-1).value:
                return False
            own_handle = True
        else:
            handle = msvcrt.get_osfhandle(descriptor)
        attributes = (W.DWORD * 2)()
        if not kernel.GetFileInformationByHandleEx(handle, 9, attributes, C.sizeof(attributes)):
            return False
        if attributes[0] & _FILE_ATTRIBUTE_REPARSE_POINT:
            return False
        owner = pointer()
        dacl = pointer()
        # SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION.
        status = advapi.GetSecurityInfo(
            handle, 1, 5, C.byref(owner), None, C.byref(dacl), None, C.byref(descriptor_block)
        )
        if status:
            return False
        if not dacl:
            return False
        owner_text = sid_text(owner)
        count = C.cast(dacl, C.POINTER(AclHeader)).contents.count
        if count > 128:
            return False
        entries: list[Entry] = []
        for index in range(count):
            ace = pointer()
            if not advapi.GetAce(dacl, index, C.byref(ace)):
                return False
            header = C.string_at(ace, 8)
            kind, flags = header[0], header[1]
            if kind not in (_ACCESS_ALLOWED, _ACCESS_DENIED):
                return False
            if flags & _INHERIT_ONLY_ACE:
                continue  # grants nothing on this object
            mask = int.from_bytes(header[4:8], "little")
            entries.append((kind, mask, sid_text(pointer(ace.value + 8))))
        return checker(owner_text, current, entries)
    except (OSError, ValueError, TypeError):
        return False
    finally:
        if descriptor_block:
            kernel.LocalFree(descriptor_block)
        if own_handle and handle:
            kernel.CloseHandle(handle)
        if token:
            kernel.CloseHandle(token)


def is_private(path: Path, *, descriptor: int | None = None) -> bool:
    """Return True if ``path`` (or its open ``descriptor``) is private to the current user."""
    return _check_acl(path, descriptor=descriptor, checker=private_acl)


def is_owner_write_protected(path: Path, *, descriptor: int | None = None) -> bool:
    """Return True if only the owner, SYSTEM and Administrators can modify ``path``."""
    return _check_acl(path, descriptor=descriptor, checker=write_protected_acl)
