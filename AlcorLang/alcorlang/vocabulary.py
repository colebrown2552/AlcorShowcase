"""The closed vocabulary that v1 statements are checked against.

A v1 statement is ``VERB OBJECT ["value"] [WITH k=v ...] [TO|FROM OBJECT name]``.  Both words
must canonicalize into a fixed table of named elements, otherwise the statement is rejected
(fail-closed).  The table is data (``data/periodic_table.json``), not code, so growing the
vocabulary never touches the parser.

The table can also say which elements are verbs and which are objects.  When it does, a token in
the wrong position is rejected.  When it does not (the built-in fallback), that check is skipped
and ``table()`` says so, because guessing roles would silently narrow the language.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .errors import AlcorLangError

# Spec section 1.2.  SET is the compatibility trap: it is an alias for Update, not a cell
# operation (spec section 3, corpus test m1-v1-set-is-update).
ALIASES: dict[str, str] = {
    "WRITE": "Update",
    "SET": "Update",
    "OPEN": "View",
    "SEND": "Message",
    "SEARCH": "Search",
    # The underscore spelling reads better in a program; the element itself stays CamelCase
    # like every other entry in the table.
    "PRIME_PROJECTION": "PrimeProjection",
    "PROJECT": "PrimeProjection",
}

# Derived from the conformance corpus, not invented: every canonical name the corpus uses as a
# verb or an object, after aliasing.  Used only when no table file can be loaded, so that a
# missing file narrows the language instead of widening it.
#   verbs   Update (WRITE/SET), View (OPEN), Message (SEND), Search (SEARCH)
#   objects Message, File, Person, Task
_FALLBACK_ELEMENTS = ("Update", "View", "Message", "Search", "File", "Person", "Task")

_TABLE_ENV = "ALCOR_PERIODIC_TABLE"
_PACKAGED_TABLE = Path(__file__).resolve().parent / "data" / "periodic_table.json"
_PACKAGED_LABEL = "data/periodic_table.json"
_FALLBACK_LABEL = "fallback:corpus-derived (no table file could be loaded)"


def _load_table_file(path: Path) -> tuple[list[str], dict[str, Any]]:
    """Read a table file in any of the three shapes such a table plausibly ships in.

    Args:
        path: The JSON file to read.

    Returns:
        The element names in file order, and each element's metadata keyed by name.

    Raises:
        ValueError: If the JSON is not a recognised table shape.
        OSError: If the file cannot be read.
    """
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    if isinstance(raw, dict) and "elements" in raw:
        raw = raw["elements"]
    if isinstance(raw, dict):
        # {"1": {"name": "Update", ...}} or {"Update": {...}}
        names: list[str] = []
        roles: dict[str, Any] = {}
        for key, val in raw.items():
            name = (val.get("name") if isinstance(val, dict) else None) or key
            names.append(name)
            if isinstance(val, dict):
                roles[name] = val
        return names, roles
    if isinstance(raw, list):
        names = []
        roles = {}
        for element in raw:
            if isinstance(element, str):
                names.append(element)
            elif isinstance(element, dict) and element.get("name"):
                names.append(element["name"])
                roles[element["name"]] = element
        return names, roles
    raise ValueError("unrecognised periodic table shape")


def _roles_from_table(meta: dict[str, Any] | None) -> tuple[set[str] | None, set[str] | None]:
    """Work out which elements may be verbs and which may be objects.

    Args:
        meta: Per-element metadata from ``_load_table_file``.

    Returns:
        ``(verbs, objects)`` as lowercased name sets, or ``(None, None)`` when the table says
        nothing about roles.  In that case the role check is skipped and ``table()`` reports
        that it is skipped, rather than guessing.
    """
    verbs: set[str] = set()
    objects: set[str] = set()
    for name, element in (meta or {}).items():
        category = ""
        for key in ("role", "kind", "category", "class", "type"):
            if isinstance(element, dict) and isinstance(element.get(key), str):
                category = element[key].lower()
                break
        # Both arms, not if/elif: an element can hold both roles, and one does.
        # `SEND Message "hi" TO Person ada` uses Message in the verb position and
        # `WRITE Message "hi" TO File t.txt` uses it in the object position; both appear in the
        # conformance corpus, so a single-role table could not describe the language.
        if "verb" in category or "action" in category:
            verbs.add(name.lower())
        if "object" in category or "noun" in category or "entity" in category:
            objects.add(name.lower())
    if not verbs and not objects:
        return None, None
    return verbs, objects


def load_table() -> tuple[dict[str, str], str, set[str] | None, set[str] | None]:
    """Load the vocabulary in force.

    A table file named by ``$ALCOR_PERIODIC_TABLE`` wins, then the packaged table, then the
    corpus-derived fallback.  Never a mixture: a partial table would silently narrow the
    vocabulary.

    Returns:
        ``(by_lowercase_name, source_label, verbs_or_None, objects_or_None)``.  The label is a
        short description of where the table came from, never an absolute path.
    """
    candidates: list[tuple[Path, str]] = []
    override = os.environ.get(_TABLE_ENV)
    if override:
        candidates.append((Path(override).expanduser(), f"${_TABLE_ENV}"))
    candidates.append((_PACKAGED_TABLE, _PACKAGED_LABEL))
    for path, label in candidates:
        if not path.is_file():
            continue
        try:
            names, meta = _load_table_file(path)
        except (ValueError, OSError, KeyError):
            continue
        if names:
            verbs, objects = _roles_from_table(meta)
            return {n.lower(): n for n in names}, label, verbs, objects
    return {n.lower(): n for n in _FALLBACK_ELEMENTS}, _FALLBACK_LABEL, None, None


_TABLE, _TABLE_SOURCE, _TABLE_VERBS, _TABLE_OBJECTS = load_table()


def table() -> dict[str, Any]:
    """Describe the vocabulary in force and where it came from.

    Returns:
        A JSON-serialisable summary: source label, whether it is the fallback, the element
        count and names, the aliases, and whether verb/object roles are enforced.
    """
    return {
        "source": _TABLE_SOURCE,
        "is_fallback": _TABLE_SOURCE.startswith("fallback:"),
        "element_count": len(_TABLE),
        "elements": sorted(_TABLE.values()),
        "aliases": dict(ALIASES),
        "role_check": (
            "enforced" if _TABLE_VERBS or _TABLE_OBJECTS else "skipped (table carries no role data)"
        ),
    }


def semantic_vocabulary_snapshot() -> dict[str, Any]:
    """Describe the vocabulary's meaning, without saying where it was loaded from.

    ``table()`` is an operator diagnostic and reports the source on purpose.  Runtime
    authority must bind the language semantics instead, and those are identical when the same
    table is checked out under two different paths.

    Returns:
        A JSON-serialisable snapshot suitable for hashing into an authority challenge.
    """
    return {
        "schema": "alcor.vocabulary.semantic.v1",
        "is_fallback": _TABLE_SOURCE.startswith("fallback:"),
        "elements": sorted(_TABLE.values()),
        "aliases": dict(ALIASES),
        "verb_roles": None if _TABLE_VERBS is None else sorted(_TABLE_VERBS),
        "object_roles": None if _TABLE_OBJECTS is None else sorted(_TABLE_OBJECTS),
    }


def canon_element(token: str, role: str) -> str:
    """Canonicalize one v1 token: apply aliases, then look it up in the table.

    Args:
        token: The word as written in the program (any case).
        role: ``"verb"`` or ``"object"``; selects which role set the element must belong to.

    Returns:
        The canonical element name.

    Raises:
        AlcorLangError: If the token is not in the table, or is in the wrong position.
    """
    key = token.lower()
    aliases_by_lower = {alias.lower(): alias for alias in ALIASES}
    if key in aliases_by_lower:
        key = ALIASES[aliases_by_lower[key]].lower()
    if key not in _TABLE:
        raise AlcorLangError(
            f"unknown {role} token {token!r}: not in the periodic table ({_TABLE_SOURCE}) "
            "- fail-closed"
        )
    allowed = _TABLE_VERBS if role == "verb" else _TABLE_OBJECTS
    if allowed and key not in allowed:
        raise AlcorLangError(f"element {_TABLE[key]!r} is not a {role} in the periodic table")
    return _TABLE[key]
