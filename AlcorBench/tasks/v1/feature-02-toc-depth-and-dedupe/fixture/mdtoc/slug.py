"""Heading text -> anchor id, the way GitHub renders it."""
import re

_DROP = re.compile(r"[^\w\- ]", re.UNICODE)


def slugify(title):
    text = title.strip().lower()
    text = _DROP.sub("", text)
    return text.replace(" ", "-")
