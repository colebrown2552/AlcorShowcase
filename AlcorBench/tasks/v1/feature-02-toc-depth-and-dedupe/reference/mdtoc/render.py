"""Render the table of contents as a nested Markdown list."""
from .headings import extract_headings
from .slug import slugify


def unique_slugs(headings):
    """Anchor for every heading; repeats get -1, -2, ... like GitHub."""
    seen = {}
    slugs = []
    for heading in headings:
        base = slugify(heading.title)
        count = seen.get(base, 0)
        slugs.append(base if count == 0 else "%s-%d" % (base, count))
        seen[base] = count + 1
    return slugs


def build_toc(text, min_level=1, max_level=6):
    """Return the TOC for `text` as Markdown ("" when there are no headings)."""
    if not (1 <= min_level <= max_level <= 6):
        raise ValueError("need 1 <= min_level <= max_level <= 6")
    headings = extract_headings(text)
    lines = []
    for heading, slug in zip(headings, unique_slugs(headings)):
        if not (min_level <= heading.level <= max_level):
            continue
        indent = "  " * (heading.level - min_level)
        lines.append("%s- [%s](#%s)" % (indent, heading.title, slug))
    return "\n".join(lines) + "\n" if lines else ""
