"""HTTP reads against staging and production.

sitekit never writes to a site over HTTP. It reads three things: the commit a site says it serves
(a response header), the controller's status document, and plain pages for the contract suites.
Changing a site goes through ``transport`` (staging) or the pointer log and controller
(production).
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlsplit

COMMIT_HEADER = "X-Sitekit-Commit"
STATUS_PATH = "/sitekit-status.json"


def _lowered(pairs: Iterable[tuple[str, str]]) -> dict[str, str]:
    return {name.lower(): value for name, value in pairs}


def fetch(
    url: str, *, method: str = "GET", timeout: float = 30.0
) -> tuple[int, bytes, dict[str, str]]:
    """Fetch ``url`` and return ``(status, body, headers)``.

    HTTP error statuses are returned rather than raised, because a 404 is a finding for the
    caller, not a crash. Status 0 means no HTTP answer at all (refused, timed out). Header names
    are lower-cased.

    Raises:
        ValueError: if ``url`` is not http or https. ``urlopen`` would also open ``file:`` and
            ``ftp:`` URLs, and a mistyped setting must never turn into a local file read.
    """
    if urlsplit(url).scheme not in ("http", "https"):
        raise ValueError(f"only http(s) URLs are allowed: {url!r}")
    request = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), _lowered(response.headers.items())
    except urllib.error.HTTPError as error:
        return error.code, error.read(), _lowered(error.headers.items())
    except (urllib.error.URLError, OSError):
        return 0, b"", {}


def head(base_url: str) -> tuple[int, str]:
    """Return ``(HTTP status, served commit)`` for a site's front page.

    The commit comes from the ``X-Sitekit-Commit`` header; it is empty when the site names none.
    """
    status, _, headers = fetch(base_url.rstrip("/") + "/", method="HEAD", timeout=20)
    return status, headers.get(COMMIT_HEADER.lower(), "")


def served_commit(base_url: str) -> str:
    """Return the commit the site says it serves, or an empty string."""
    return head(base_url)[1]


def controller_status(base_url: str) -> dict[str, Any]:
    """Return the controller's published status document, or ``{}`` if there is none."""
    status, body, _ = fetch(f"{base_url.rstrip('/')}{STATUS_PATH}?t={time.time_ns()}")
    if status != 200:
        return {}
    try:
        data = json.loads(body)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}
