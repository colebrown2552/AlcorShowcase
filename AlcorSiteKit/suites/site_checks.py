"""Contract suite: structure and links of every page reachable from the home page.

Usage::

    python suites/site_checks.py BASE_URL --check structure|links [--max-pages N]

Prints one ``PASS`` or ``FAIL`` line per check and exits 1 if any check fails, which is the
protocol ``sitekit contract`` expects of a suite. It only reads pages, so it is safe to run
against production. If the site does not answer at all the home page check fails, so an outage
can never look like a pass.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Run as a script, this file is not part of the package; put the package on the path so the shared
# crawler is imported instead of copied.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sitekit.net import fetch  # noqa: E402
from sitekit.sitescan import FetchedPage, crawl, internal_path  # noqa: E402

Result = tuple[bool, str]


def structure(pages: dict[str, FetchedPage]) -> list[Result]:
    """Check that each crawled page loads and is well formed for people and search engines."""
    results: list[Result] = []
    for path, page in pages.items():
        loaded = page.status == 200
        detail = "" if loaded else f" (got {page.status}, linked from {page.referrer or 'start'})"
        results.append((loaded, f"{path} answers 200{detail}"))
        if page.scan is None:
            continue
        scan = page.scan
        results += [
            (bool(scan.title.strip()), f"{path} has a title"),
            (
                scan.h1_count == 1,
                f"{path} has exactly one h1"
                + ("" if scan.h1_count == 1 else f" (found {scan.h1_count})"),
            ),
            (bool(scan.lang), f"{path} declares a language"),
            (scan.images_without_alt == 0, f"{path} gives every image alt text"),
        ]
    return results


def links(base: str, pages: dict[str, FetchedPage]) -> list[Result]:
    """Check that every internal link, stylesheet, script and image resolves."""
    results: list[Result] = []
    seen: set[str] = set()
    for path, page in pages.items():
        if page.scan is None:
            continue
        for reference in [*page.scan.anchors, *page.scan.assets]:
            target = internal_path(base, path, reference)
            if target is None or target in seen:
                continue
            seen.add(target)
            status = pages[target].status if target in pages else fetch(base + target)[0]
            results.append(
                (status == 200, f"{target} resolves (linked from {path}; HTTP {status})")
            )
    if not results:
        results.append((False, "no internal links found; the crawl reached nothing"))
    return results


def main() -> int:
    """Run the requested check and print its verdict lines."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("base_url")
    parser.add_argument("--check", choices=["structure", "links"], required=True)
    parser.add_argument("--max-pages", type=int, default=50)
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    pages = crawl(base, max_pages=args.max_pages)
    results = structure(pages) if args.check == "structure" else links(base, pages)
    for ok, text in results:
        print(f"{'PASS' if ok else 'FAIL'} {text}")
    return 0 if all(ok for ok, _ in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
