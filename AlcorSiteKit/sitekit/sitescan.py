"""Read a deployed site the way a crawler would: fetch pages, extract structure, follow links.

Shared by the contract suites (which judge what they find) and the cold-read text capture (which
hands the visible text to readers). Standard library only, so it runs wherever Python does.
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from .net import fetch

# Tags that start a new line of visible text; without them "Menu" and "Contact" run together.
_BLOCKS = frozenset(
    {"address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption"}
    | {"footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav"}
    | {"ol", "p", "pre", "section", "table", "td", "th", "tr", "ul"}
)
_HIDDEN = frozenset({"script", "style", "noscript", "template"})


class PageScan(HTMLParser):
    """What one HTML page says about itself: title, language, headings, links, text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.lang = ""
        self.description = ""
        self.h1_count = 0
        self.images_without_alt = 0
        self.anchors: list[str] = []
        self.assets: list[str] = []
        self._in_title = False
        self._hidden_depth = 0
        self._main_depth = 0
        self._main_text: list[str] = []
        self._body_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Record structure (title, language, headings, links) as each opening tag arrives."""
        attr = {name: value or "" for name, value in attrs}
        if tag == "html":
            self.lang = attr.get("lang", "")
        elif tag == "title":
            self._in_title = True
        elif tag == "meta" and attr.get("name", "").lower() == "description":
            self.description = attr.get("content", "")
        elif tag == "h1":
            self.h1_count += 1
        elif tag == "a" and attr.get("href"):
            self.anchors.append(attr["href"])
        elif tag == "link" and attr.get("href"):
            self.assets.append(attr["href"])
        elif tag in ("script", "img", "source") and attr.get("src"):
            self.assets.append(attr["src"])
        if tag == "img" and "alt" not in dict(attrs):
            self.images_without_alt += 1
        if tag in _HIDDEN:
            self._hidden_depth += 1
        if tag == "main":
            self._main_depth += 1
        if tag in _BLOCKS:
            self._emit("\n")

    def handle_endtag(self, tag: str) -> None:
        """Close the title, hidden-content and main-content scopes opened by start tags."""
        if tag == "title":
            self._in_title = False
        if tag in _HIDDEN and self._hidden_depth:
            self._hidden_depth -= 1
        if tag == "main" and self._main_depth:
            self._main_depth -= 1
        if tag in _BLOCKS:
            self._emit("\n")

    def handle_data(self, data: str) -> None:
        """Collect the title text and the visible text, skipping script and style content."""
        if self._in_title:
            self.title += data
        elif not self._hidden_depth:
            self._emit(data)

    def _emit(self, text: str) -> None:
        self._body_text.append(text)
        if self._main_depth:
            self._main_text.append(text)

    def visible_text(self) -> str:
        """Return the page's readable text: the ``<main>`` element if it has one, else the body."""
        raw = "".join(self._main_text or self._body_text)
        lines = (re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in raw.split("\n"))
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def scan_html(html: str) -> PageScan:
    """Parse ``html`` and return what the page says about itself."""
    scan = PageScan()
    scan.feed(html)
    scan.close()
    return scan


def internal_path(base_url: str, page_path: str, href: str) -> str | None:
    """Resolve ``href`` found on ``page_path`` to a path on the same site, or None.

    Fragments and query strings are dropped (they do not change which file is served), and
    anything that is not http(s) on the same host (``mailto:``, other sites) is not internal.
    """
    href = href.strip()
    if not href or href.startswith("#"):
        return None
    parts = urlsplit(urljoin(base_url + page_path, href))
    if parts.scheme not in ("http", "https") or parts.netloc != urlsplit(base_url).netloc:
        return None
    return parts.path or "/"


@dataclass
class FetchedPage:
    """One crawled path: how it answered, what it contained, and who linked to it."""

    path: str
    status: int
    scan: PageScan | None
    referrer: str


def crawl(base_url: str, start: str = "/", max_pages: int = 50) -> dict[str, FetchedPage]:
    """Fetch ``start`` and every page reachable from it by internal links, breadth first.

    Args:
        base_url: site root, e.g. ``http://127.0.0.1:PORT``.
        start: path to begin from.
        max_pages: stop after this many paths so a link loop or a huge site cannot run forever.

    Returns:
        Every path visited, in visiting order.
    """
    base = base_url.rstrip("/")
    pages: dict[str, FetchedPage] = {}
    queue: deque[tuple[str, str]] = deque([(start, "")])
    while queue and len(pages) < max_pages:
        path, referrer = queue.popleft()
        if path in pages:
            continue
        status, body, headers = fetch(base + path)
        scan = None
        if status == 200 and "html" in headers.get("content-type", "").lower():
            scan = scan_html(body.decode("utf-8", errors="replace"))
            for href in scan.anchors:
                target = internal_path(base, path, href)
                if target is not None and target not in pages:
                    queue.append((target, path))
        pages[path] = FetchedPage(path, status, scan, referrer)
    return pages
