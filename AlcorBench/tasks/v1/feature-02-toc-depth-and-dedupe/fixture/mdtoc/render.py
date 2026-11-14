"""Render the table of contents as a nested Markdown list."""
from .headings import extract_headings
from .slug import slugify


def build_toc(text):
    """Return the TOC for `text` as Markdown ("" when there are no headings)."""
    lines = []
    for heading in extract_headings(text):
        indent = "  " * (heading.level - 1)
        lines.append("%s- [%s](#%s)" % (indent, heading.title, slugify(heading.title)))
    return "\n".join(lines) + "\n" if lines else ""
