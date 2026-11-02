"""Render a command's real output as a terminal-window screenshot (SVG, optionally PNG).

Screenshots of command-line tools tend to go stale or get staged. This script runs the actual
command, captures what it prints, and draws it as an SVG terminal window, so a README image is
always a faithful copy of a real run. SVG keeps the text sharp on GitHub and diffs as text.

PNG output (for collages and social previews) is produced by a headless Chromium screenshot of
the SVG, using a throwaway profile directory so no real browser profile is touched.

Usage:
    python scripts/render_terminal.py --title "AlcorLedger demo" \
        --out AlcorLedger/screenshots/demo -- python AlcorLedger/demo/run_demo.py
    python scripts/render_terminal.py --from-file output.txt --title "..." --out path/stem --png
"""

from __future__ import annotations

import argparse
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
CHAR_W, LINE_H, PAD, BAR = 8.4, 19, 18, 34  # Pixel metrics for 14px monospace text.
CHROME_CANDIDATES = [
    os.environ.get("CHROME_PATH", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "google-chrome",
    "chromium",
    "chromium-browser",
]


def capture(command: list[str], cwd: Path) -> str:
    """Run ``command`` and return stdout+stderr as text, failing if the command fails.

    A screenshot of a failing demo would be misleading, so a non-zero exit stops the render.
    """
    env = {**os.environ, "PYTHONUTF8": "1", "NO_COLOR": "1"}
    result = subprocess.run(
        command, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", check=False
    )
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit(f"command failed with exit code {result.returncode}: {command}")
    return result.stdout + result.stderr


def fit_lines(text: str, width: int, max_lines: int) -> list[str]:
    """Strip colors, expand tabs, wrap to ``width`` and keep head and tail if too long."""
    raw_lines = ANSI.sub("", text).expandtabs(4).rstrip().splitlines()
    # Elide whole source lines before wrapping, so the cut never lands inside a wrapped line.
    if len(raw_lines) > max_lines:
        head = max_lines * 2 // 3
        tail = max_lines - head - 1
        omitted = len(raw_lines) - head - tail
        raw_lines = raw_lines[:head] + [f"... ({omitted} lines omitted) ..."] + raw_lines[-tail:]
    lines: list[str] = []
    for raw in raw_lines:
        while len(raw) > width:
            lines.append(raw[:width])
            raw = "  " + raw[width:]
        lines.append(raw)
    return lines


def display_command(command: list[str], root: Path) -> str:
    """Show the command the way a reader would type it: ``python`` and repo-relative paths.

    The real argv carries absolute interpreter and file paths, which are both noisy and private
    (they contain the local username), so they never reach the image.
    """
    shown = []
    for arg in command:
        if arg == sys.executable or Path(arg).name.lower() in {"python.exe", "python3", "python"}:
            shown.append("python")
            continue
        try:
            shown.append(Path(arg).resolve().relative_to(root).as_posix())
        except (ValueError, OSError):
            shown.append(arg)
    return " ".join(shown)


def to_svg(title: str, prompt: str, lines: list[str], width_chars: int) -> str:
    """Draw a dark terminal window with a title bar, the prompt line and the output."""
    body = [*fit_lines(f"$ {prompt}", width_chars, 3), *lines]
    width = int(width_chars * CHAR_W + PAD * 2)
    height = int(BAR + PAD + len(body) * LINE_H + PAD)
    rows = []
    for i, line in enumerate(body):
        y = BAR + PAD + (i + 1) * LINE_H - 5
        color = "#7ee787" if i == 0 else "#e6edf3"
        text = html.escape(line)
        rows.append(f'<text x="{PAD}" y="{y}" fill="{color}" xml:space="preserve">{text}</text>')
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" \
viewBox="0 0 {width} {height}" role="img" aria-label="{html.escape(title)}">
  <rect width="{width}" height="{height}" rx="10" fill="#0d1117"/>
  <rect width="{width}" height="{BAR}" rx="10" fill="#161b22"/>
  <rect y="{BAR - 10}" width="{width}" height="10" fill="#161b22"/>
  <circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/>
  <circle cx="60" cy="17" r="6" fill="#28c840"/>
  <text x="{width / 2}" y="22" fill="#8b949e" text-anchor="middle" font-family="Segoe UI, \
Helvetica, Arial, sans-serif" font-size="13">{html.escape(title)}</text>
  <g font-family="Cascadia Mono, Consolas, Menlo, DejaVu Sans Mono, monospace" font-size="14">
    {chr(10).join("    " + r for r in rows)}
  </g>
</svg>
"""


def find_chrome() -> str | None:
    """Return the first Chrome/Chromium executable found, or None."""
    for candidate in CHROME_CANDIDATES:
        if not candidate:
            continue
        found = shutil.which(candidate) or (candidate if Path(candidate).is_file() else None)
        if found:
            return found
    return None


def to_png(svg_path: Path, png_path: Path, size: tuple[int, int]) -> None:
    """Screenshot the SVG, scaled to fit and centered, with headless Chromium at ``size``."""
    chrome = find_chrome()
    if chrome is None:
        raise SystemExit("PNG output needs Chrome/Chromium; set CHROME_PATH")
    with tempfile.TemporaryDirectory() as tmp:
        # A wrapper page scales the window image to the canvas, so every PNG has the same frame
        # whatever the output length.
        page = Path(tmp) / "frame.html"
        page.write_text(
            '<html><body style="margin:0;height:100vh;display:flex;align-items:center;'
            'justify-content:center;background:#010409">'
            f'<img src="{svg_path.resolve().as_uri()}" style="max-width:94vw;max-height:92vh">'
            "</body></html>",
            encoding="utf-8",
        )
        subprocess.run(
            [
                chrome,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--allow-file-access-from-files",
                f"--user-data-dir={Path(tmp) / 'profile'}",
                f"--window-size={size[0]},{size[1]}",
                f"--screenshot={png_path.resolve()}",
                page.as_uri(),
            ],
            check=True,
            capture_output=True,
        )


def main() -> int:
    """Parse arguments, capture output, and write the SVG (and PNG when asked)."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--title", required=True, help="window title")
    parser.add_argument("--out", required=True, help="output path without extension")
    parser.add_argument("--from-file", help="render this text file instead of running a command")
    parser.add_argument("--prompt", help="prompt line to show (defaults to the command)")
    parser.add_argument("--cwd", default=".", help="working directory for the command")
    parser.add_argument("--width", type=int, default=110, help="characters per line")
    parser.add_argument("--max-lines", type=int, default=44, help="lines kept from the output")
    parser.add_argument("--png", action="store_true", help="also write a 1440x900 PNG")
    parser.add_argument("--tile", help="also write a 480x300 PNG thumbnail to this path")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- command to run")
    args = parser.parse_args()

    command = [a for a in args.command if a != "--"]
    if args.from_file:
        text = Path(args.from_file).read_text(encoding="utf-8")
    elif command:
        text = capture(command, Path(args.cwd))
    else:
        raise SystemExit("give a command after -- or use --from-file")

    root = Path(__file__).resolve().parent.parent
    prompt = args.prompt or (
        display_command(command, root) if command else Path(args.from_file).name
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    svg = out.with_suffix(".svg")
    svg.write_text(
        to_svg(args.title, prompt, fit_lines(text, args.width, args.max_lines), args.width),
        encoding="utf-8",
    )
    print(f"wrote {svg}")
    if args.png:
        to_png(svg, out.with_suffix(".png"), (1440, 900))
        print(f"wrote {out.with_suffix('.png')}")
    if args.tile:
        Path(args.tile).parent.mkdir(parents=True, exist_ok=True)
        to_png(svg, Path(args.tile), (480, 300))
        print(f"wrote {args.tile}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
