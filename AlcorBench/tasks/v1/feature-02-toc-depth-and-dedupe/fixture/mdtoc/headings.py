"""Find ATX headings (# Title) in Markdown, ignoring fenced code blocks."""
import re
from dataclasses import dataclass

_ATX = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")


@dataclass
class Heading:
    level: int
    title: str
    line: int  # 1-based line number in the source


def extract_headings(text):
    headings = []
    fence = None
    for number, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            continue
        if fence is not None:
            continue
        match = _ATX.match(raw)
        if match:
            headings.append(Heading(len(match.group(1)), match.group(2).strip(), number))
    return headings
