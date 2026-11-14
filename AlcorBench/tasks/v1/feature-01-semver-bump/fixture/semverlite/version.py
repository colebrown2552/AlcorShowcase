"""Semantic versions (https://semver.org) without the parts we never use."""
import re
from dataclasses import dataclass

_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)


@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    prerelease: str = ""
    build: str = ""

    def __str__(self):
        text = "%d.%d.%d" % (self.major, self.minor, self.patch)
        if self.prerelease:
            text += "-" + self.prerelease
        if self.build:
            text += "+" + self.build
        return text


def parse(text):
    """Parse a version string, raising ValueError if it is not valid semver."""
    match = _PATTERN.match(text.strip())
    if not match:
        raise ValueError("not a semantic version: %r" % text)
    major, minor, patch, pre, build = match.groups()
    return Version(int(major), int(minor), int(patch), pre or "", build or "")


def _pre_key(prerelease):
    # A release sorts after any of its pre-releases.
    if not prerelease:
        return (1,)
    parts = []
    for item in prerelease.split("."):
        if item.isdigit():
            parts.append((0, int(item), ""))
        else:
            parts.append((1, 0, item))
    return (0, tuple(parts))


def compare(a, b):
    """Return -1, 0 or 1 by semver precedence (build metadata is ignored)."""
    ka = (a.major, a.minor, a.patch, _pre_key(a.prerelease))
    kb = (b.major, b.minor, b.patch, _pre_key(b.prerelease))
    return (ka > kb) - (ka < kb)
