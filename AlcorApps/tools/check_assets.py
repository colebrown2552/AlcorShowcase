"""Check that every AlcorApps page has all the files it loads.

Starts from each app's ``index.html`` and follows references the way the browser would: script
and stylesheet links, relative imports, worker URLs, files named by bare name next to the script
that loads them, and ``url()`` references in CSS. Any reference that points inside this folder but
has no file is reported, and the script exits non-zero.

Runs on a clean machine with the Python standard library only. It cannot prove the apps work (that
needs a browser), but it catches the most common breakage: a missing file.
"""

import posixpath
import re
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
# Attribute links in HTML (src="..." and href="...") that are not full URLs or anchors.
HTML_REF = re.compile(r"""\b(?:src|href)=["'](?!https?:|data:|mailto:|tel:|#|//)([^"'?#]+)""")
# Quoted relative paths in JS and CSS: './x.js', '../lib/y.mjs'.
REL_REF = re.compile(r"""["'`(](\.{1,2}/[A-Za-z0-9_\-./]+\.[a-z0-9]{2,5})["'`)]""")
# Files named without a path, resolved next to the script that names them.
BARE_REF = re.compile(r"""["'`]([a-z0-9][a-z0-9\-]*\.(?:js|mjs|css|wasm|json))["'`]""")
CSS_URL = re.compile(r"""url\(\s*["']?(?!data:|https?:|#)([^"')?#]+)""")
# require('./x.js') only runs under Node (tests); browsers take the other branch, so skip it.
NODE_REQUIRE = re.compile(r"""\brequire\(\s*["'][^"']+["']\s*\)""")


def resolve(base_dir: str, ref: str) -> str:
    """Return ``ref`` resolved against ``base_dir`` as a path relative to ``web/``."""
    return posixpath.normpath(posixpath.join(base_dir, ref))


def check_app(app: Path) -> list[str]:
    """Follow every reference reachable from one app page.

    Args:
        app: The app folder, containing ``index.html``.

    Returns:
        Human-readable descriptions of missing files; empty when all are present.
    """
    missing: list[str] = []
    seen: set[str] = set()
    todo = [(f"{app.name}/index.html", None)]
    while todo:
        rel, origin = todo.pop()
        if rel in seen or rel.startswith(".."):
            continue
        seen.add(rel)
        path = WEB / rel
        if not path.is_file():
            missing.append(f"{rel} (referenced by {origin})")
            continue
        if path.suffix not in (".html", ".js", ".mjs", ".css"):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        base = posixpath.dirname(rel)
        refs = []
        if path.suffix == ".html":
            refs += HTML_REF.findall(text)
        else:
            text = NODE_REQUIRE.sub("", text)
            refs += REL_REF.findall(text)
            # A bare name only counts when the file exists or looks like a sibling module; many
            # bare strings in scripts are download names, not files to load.
            refs += [n for n in BARE_REF.findall(text) if (WEB / resolve(base, n)).exists()]
        if path.suffix == ".css":
            refs += CSS_URL.findall(text)
        for ref in refs:
            target = resolve(base, ref)
            if (WEB / target).is_dir() or ref.endswith("/"):
                continue
            todo.append((target, rel))
    return missing


def main() -> int:
    """Check all apps and print a one-line result per app."""
    apps = sorted(p for p in WEB.iterdir() if (p / "index.html").is_file())
    failures = 0
    for app in apps:
        missing = check_app(app)
        status = "ok" if not missing else f"{len(missing)} missing"
        print(f"{app.name}: {status}")
        for line in missing:
            print(f"  - {line}")
        failures += bool(missing)
    print(f"{len(apps) - failures}/{len(apps)} apps complete")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
