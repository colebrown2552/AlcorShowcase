"""Cold read: would a stranger know what the site offers, who it is for and what to do next?

Every captured page is shown to fresh readers that know nothing about the company:

* a "5-second" read: only what fits on the first screen (a screenshot, or its text when the page
  was captured without a browser);
* a "30-second" read: the page's visible text.

A separate judge scores each answer against what the site *intends* to say (``intended_file``).
The readers are model proxies for strangers, not strangers, and the report says so. Cold read is
advisory: it feeds the review pack and no gate depends on it. Page text is untrusted data, so a
reader sees one file in an empty folder and nothing else.

The model sits behind ``ColdReadModel``. Two implementations ship:

* ``ClaudeCliModel`` runs the ``claude`` command line, once per read, in an empty folder.
* ``KeywordModel`` is an offline stand-in for the demo. It extracts sentences and scores by word
  overlap. It understands nothing; it exists so the whole path (capture, read, judge, report,
  review) runs without a model, and its scores say nothing about how a model would read the page.

To plug in another model, write a class with ``read`` and ``judge`` (see ``ColdReadModel``) and
pass ``--judge package.module:ClassName``.
"""

from __future__ import annotations

import concurrent.futures
import importlib
import json
import re
import shutil
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from .fsutil import read_json, utc_now
from .net import fetch
from .sitescan import scan_html

DEFAULT_PERSONAS: tuple[tuple[str, str], ...] = (
    (
        "visitor",
        "You are an ordinary adult who clicked a link to this website without knowing anything"
        " about it.",
    ),
    (
        "owner",
        "You run a 12-person plumbing company. You landed here from a search and know nothing"
        " about this company.",
    ),
    (
        "buyer",
        "You are a skeptical operations manager at a 200-person firm evaluating vendors. You have"
        " never heard of this company.",
    ),
)
IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})
FOLD_CHARS = 600  # how much text stands in for "the first screen" when there is no screenshot
OFFER_THRESHOLD = 75  # a first look that conveys the offer to fewer than this % is flagged

READ_PROMPT = """{persona}
{exposure}
Answer only from what you saw, in this exact JSON (no prose around it):
{{"sells": "<one sentence: what this company sells or offers>",
 "for_whom": "<who it is for>",
 "next": "<what you would do next on this page, or 'leave'>",
 "confusing": "<the one thing that confused you or made you hesitate, or 'nothing'>",
 "trust": <1-5>,
 "trust_why": "<one short reason>"}}"""

EXPOSURE = {
    "5s": "You glanced at this web page for about five seconds; this is exactly what was on your"
    " screen: {file}. Open that image and look at it once, quickly.",
    "5s-text": "You glanced at this web page for about five seconds; the text that fit on your"
    " first screen is in {file}. Read it once, quickly.",
    "30s": "You skimmed this web page for about thirty seconds. Its visible text is in {file}."
    " Read it once, quickly.",
}

JUDGE_PROMPT = """Score a stranger's read of a website against what the site intends to communicate.
INTENDED: {intended}
PAGE: {page} ({view}, {exposure} read)
READER ANSWER: {answer}
Score each 0 (wrong or missing), 1 (partly), 2 (right): offer, audience, next.
Reply with only JSON: {{"offer": n, "audience": n, "next": n, "note": "<under 20 words on the \
biggest gap>"}}"""


class ColdReadError(Exception):
    """Raised when a cold read cannot run (no model, no capture, bad intended statement)."""


class ColdReadModel(Protocol):
    """What cold read needs from a language model: answer as a reader, then score as a judge."""

    name: str

    def read(self, persona: str, exposure: str, material: Path) -> dict[str, Any]:
        """Answer the reader questions from ``material`` (an image or a text file).

        Args:
            persona: who the reader is pretending to be.
            exposure: ``"5s"`` (first screen) or ``"30s"`` (skim of the whole page).
            material: the one file the reader may look at.

        Returns:
            ``{"sells", "for_whom", "next", "confusing", "trust", "trust_why"}``, or
            ``{"error": ...}`` if the reader could not answer.
        """
        ...

    def judge(
        self,
        intended: Mapping[str, str],
        page: str,
        view: str,
        exposure: str,
        answer: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Score ``answer`` 0-2 for ``offer``, ``audience`` and ``next`` against ``intended``.

        Returns:
            ``{"offer": n, "audience": n, "next": n, "note": "..."}``.
        """
        ...


class ClaudeCliModel:
    """Reads and judges by running the ``claude`` command line in an empty folder."""

    name = "claude CLI"

    def __init__(self, model: str = "sonnet", timeout: float = 300.0) -> None:
        self.model = model
        self.timeout = timeout
        self.executable = shutil.which("claude")
        if self.executable is None:
            raise ColdReadError("the claude CLI is not on PATH")

    def _ask(self, prompt: str, cwd: str, tools: str | None = None) -> dict[str, Any]:
        # --setting-sources project skips the user-level settings, and the empty folder has no
        # project settings, so the reader starts with no knowledge of the company or the person.
        command = [
            str(self.executable),
            "-p",
            prompt,
            "--output-format",
            "json",
            "--model",
            self.model,
            "--setting-sources",
            "project",
        ]
        if tools:
            command += ["--allowedTools", tools]
        try:
            done = subprocess.run(
                command,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {"error": "timed out"}
        text = done.stdout
        try:
            wrapper = json.loads(done.stdout)
            if isinstance(wrapper, dict):
                text = str(wrapper.get("result", ""))
        except ValueError:
            pass
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return {"error": (done.stderr or text)[-300:]}
        try:
            return json.loads(match.group(0))
        except ValueError:
            return {"error": "unparsed", "raw": match.group(0)[:300]}

    def read(self, persona: str, exposure: str, material: Path) -> dict[str, Any]:
        """Run one reader in a fresh folder that holds only ``material``."""
        image = material.suffix.lower() in IMAGE_SUFFIXES
        with tempfile.TemporaryDirectory(prefix="coldread-") as tmp:
            name = f"screen{material.suffix.lower()}" if image else "page.txt"
            shutil.copy(material, Path(tmp) / name)
            kind = "30s" if exposure == "30s" else ("5s" if image else "5s-text")
            prompt = READ_PROMPT.format(persona=persona, exposure=EXPOSURE[kind].format(file=name))
            return self._ask(prompt, tmp, tools="Read")

    def judge(
        self,
        intended: Mapping[str, str],
        page: str,
        view: str,
        exposure: str,
        answer: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Score one answer in a fresh folder; the judge needs no tools."""
        prompt = JUDGE_PROMPT.format(
            intended=json.dumps(dict(intended)),
            page=page,
            view=view,
            exposure=exposure,
            answer=json.dumps(dict(answer)),
        )
        with tempfile.TemporaryDirectory(prefix="coldread-") as tmp:
            return self._ask(prompt, tmp)


_STOPWORDS = frozenset(
    {"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is"}
    | {"it", "its", "of", "on", "or", "our", "that", "the", "their", "this", "to", "we", "with"}
    | {"you", "your", "who", "what", "when", "where", "how", "any", "can", "all", "not", "but"}
    | {"more", "most", "also", "very"}
)
# Words that signal a sentence is addressed to a group of people / asks the reader to act.
_AUDIENCE_CUES = frozenset(
    {"for", "customers", "clients", "families", "households", "businesses", "teams", "people"}
    | {"everyone", "anyone", "owners", "residents", "neighbours", "students", "beginners"}
)
_ACTION_CUES = frozenset(
    {"order", "visit", "call", "book", "contact", "buy", "subscribe", "join", "request", "start"}
    | {"try", "shop", "download", "sign", "get"}
)


def _stem(word: str) -> str:
    """Strip common endings so "cakes" matches "cake" and "baked" matches "bake" (crude)."""
    for suffix in ("ing", "ed", "es", "s"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            word = word[: -len(suffix)]
            break
    if word.endswith("y"):
        word = word[:-1] + "i"
    return word.rstrip("e")


def _words(text: str) -> set[str]:
    return {
        _stem(w) for w in re.findall(r"[a-z]+", text.lower()) if w not in _STOPWORDS and len(w) > 2
    }


def _sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+|\n+", text) if part.strip()]


def _grade(ratio: float) -> int:
    return 2 if ratio >= 0.5 else (1 if ratio >= 0.25 else 0)


class KeywordModel:
    """Offline stand-in for a model: extracts sentences, scores by word overlap.

    The "reader" answers with the first sentences, the sentences that address a group of people
    and the sentences that ask for an action. The "judge" grades each answer by the share of the
    intended statement's content words it repeats. Both are deterministic and need no network.
    It cannot see images and it does not role-play the persona.
    """

    name = "keyword stand-in (offline, no model called)"

    def read(self, persona: str, exposure: str, material: Path) -> dict[str, Any]:
        """Extract an answer from a text file; images are reported as unreadable."""
        if material.suffix.lower() in IMAGE_SUFFIXES:
            return {"error": "the keyword stand-in cannot read images"}
        sentences = _sentences(material.read_text(encoding="utf-8", errors="replace"))
        audience = [s for s in sentences if set(re.findall(r"[a-z]+", s.lower())) & _AUDIENCE_CUES]
        actions = [s for s in sentences if set(re.findall(r"[a-z]+", s.lower())) & _ACTION_CUES]
        return {
            "sells": " ".join(sentences[:2])[:300],
            "for_whom": " ".join(audience)[:300] or "unclear",
            "next": " ".join(actions)[:300] or "leave",
            "confusing": "nothing" if sentences else "the page has no text",
            "trust": None,
            "trust_why": "not judged by the keyword stand-in",
        }

    def judge(
        self,
        intended: Mapping[str, str],
        page: str,
        view: str,
        exposure: str,
        answer: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Grade 0-2 per field by overlap with the intended statement."""
        fields = {"offer": "sells", "audience": "for_whom", "next": "next"}
        ratios = {}
        for key, answer_key in fields.items():
            wanted = _words(intended[key])
            got = _words(str(answer.get(answer_key, "")))
            ratios[key] = len(got & wanted) / len(wanted) if wanted else 0.0
        weakest = min(ratios, key=lambda key: ratios[key])
        return {
            **{key: _grade(ratio) for key, ratio in ratios.items()},
            "note": f"weakest: {weakest} ({round(100 * ratios[weakest])}% of its key words)",
        }


def load_model(spec: str) -> ColdReadModel:
    """Build a model from a name: ``keyword``, ``claude`` / ``claude:<model>`` or ``module:Class``.

    Raises:
        ColdReadError: if the name is unknown, the class cannot be imported or the CLI is absent.
    """
    if spec == "keyword":
        return KeywordModel()
    if spec == "claude" or spec.startswith("claude:"):
        return ClaudeCliModel(model=spec.partition(":")[2] or "sonnet")
    module_name, _, class_name = spec.partition(":")
    if not module_name or not class_name:
        raise ColdReadError(f"unknown judge {spec!r}: use keyword, claude or module:Class")
    try:
        return getattr(importlib.import_module(module_name), class_name)()
    except (ImportError, AttributeError) as error:
        raise ColdReadError(f"cannot load judge {spec!r}: {error}") from error


def load_intended(path: Path | None) -> dict[str, str]:
    """Read what the site should leave in a stranger's head.

    The file is a JSON object with ``offer``, ``audience`` and ``next`` sentences. There is no
    default: a cold read without a stated intention has nothing to score against.

    Raises:
        ColdReadError: if no file is configured or it lacks one of the three keys.
    """
    if path is None:
        raise ColdReadError("set intended_file: the JSON with offer, audience and next sentences")
    data = read_json(path)
    if not isinstance(data, dict) or not all(
        isinstance(data.get(k), str) for k in ("offer", "audience", "next")
    ):
        raise ColdReadError(f"{path.name} must be an object with string keys offer, audience, next")
    return {key: data[key] for key in ("offer", "audience", "next")}


def page_slug(path: str) -> str:
    """Return a file-name-safe name for a URL path (``/`` becomes ``home``)."""
    return re.sub(r"[^A-Za-z0-9]+", "_", path.strip("/")) or "home"


def normalize_pages(tokens: Sequence[str]) -> list[str]:
    """Accept ``home``, ``menu`` or ``/menu/`` and return URL paths with slashes."""
    pages = []
    for token in tokens:
        token = token.strip()
        if token == "home" or token == "/":
            pages.append("/")
        elif token:
            pages.append("/" + token.strip("/") + "/")
    return pages


def capture_text(base_url: str, pages: Sequence[str], out_dir: Path) -> Path:
    """Capture pages without a browser: fetch the HTML and keep its visible text.

    The first ``FOLD_CHARS`` characters stand in for the first screen, because a text capture has
    no screenshot. ``browser/capture.mjs`` produces real screenshots when Playwright is available.

    Returns:
        The path of the manifest the readers start from.

    Raises:
        ColdReadError: if a page does not answer 200.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for path in pages:
        status, body, _ = fetch(base_url.rstrip("/") + path)
        if status != 200:
            raise ColdReadError(f"{path} answered HTTP {status}; nothing to read")
        text = scan_html(body.decode("utf-8", errors="replace")).visible_text()
        slug = page_slug(path)
        (out_dir / f"{slug}-desktop.txt").write_text(text[:12000], encoding="utf-8")
        # A page that fits on one screen has no separate first look: the full read covers it.
        fold = f"{slug}-desktop-fold.txt" if len(text) > FOLD_CHARS else None
        if fold:
            (out_dir / fold).write_text(text[:FOLD_CHARS], encoding="utf-8")
        entries.append(
            {
                "path": path,
                "view": "desktop",
                "shot": None,
                "fold": fold,
                "text": f"{slug}-desktop.txt",
                "chars": len(text),
            }
        )
    manifest = out_dir / "manifest.json"
    manifest.write_text(
        json.dumps({"captured": utc_now(), "mode": "text", "pages": entries}, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def _one_read(
    model: ColdReadModel,
    intended: Mapping[str, str],
    capture: Path,
    item: Mapping[str, Any],
    persona: tuple[str, str],
    exposure: str,
) -> dict[str, Any]:
    name = (item.get("shot") or item.get("fold")) if exposure == "5s" else item["text"]
    try:
        answer = model.read(persona[1], exposure, capture / name)
        score = (
            {}
            if "error" in answer
            else model.judge(intended, item["path"], item["view"], exposure, answer)
        )
    except Exception as error:  # a model failure is a data point for the report, not a crash
        answer, score = {"error": type(error).__name__}, {}
    return {
        "path": item["path"],
        "view": item["view"],
        "persona": persona[0],
        "exposure": exposure,
        "answer": answer,
        "score": score,
    }


def run_reads(
    capture: Path,
    model: ColdReadModel,
    intended: Mapping[str, str],
    *,
    personas: int = 3,
    pages: Sequence[str] = (),
    jobs: int = 3,
) -> list[dict[str, Any]]:
    """Read and judge every captured page; write ``reads.jsonl`` and return the rows.

    Args:
        capture: folder holding ``manifest.json`` and the captured files.
        model: who reads and judges.
        intended: the offer / audience / next sentences the site means to convey.
        personas: how many of the default personas read each page.
        pages: restrict to these paths (empty means all captured pages).
        jobs: how many reads may run at once.
    """
    manifest = read_json(capture / "manifest.json")
    if not isinstance(manifest, dict) or not manifest.get("pages"):
        raise ColdReadError("the capture has no manifest.json with pages")
    wanted = set(normalize_pages(pages))
    items = [i for i in manifest["pages"] if not wanted or i["path"] in wanted]
    plan = []
    for item in items:
        for persona in DEFAULT_PERSONAS[: max(1, personas)]:
            for exposure in ("5s", "30s"):
                if exposure == "5s" and not (item.get("shot") or item.get("fold")):
                    continue
                if exposure == "30s" and item["view"] == "phone":
                    continue  # the text is the same on both views
                plan.append((item, persona, exposure))
    rows = []
    with (
        (capture / "reads.jsonl").open("w", encoding="utf-8", newline="\n") as handle,
        concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool,
    ):
        for row in pool.map(lambda job: _one_read(model, intended, capture, *job), plan):
            handle.write(json.dumps(row) + "\n")
            rows.append(row)
            score = row["score"]
            shown = " ".join(
                f"{label}={score.get(key, '?')}"
                for label, key in (("offer", "offer"), ("aud", "audience"), ("next", "next"))
            )
            who = f"{row['view']:<7} {row['exposure']:<3} {row['persona']:<7}"
            print(f"{row['path']:<22} {who} {shown}", flush=True)
    return rows


def _percent(rows: list[dict[str, Any]], key: str) -> int:
    """Share of the 2-point maximum earned for ``key`` across ``rows`` (100 = all correct)."""
    return round(100 * sum(r["score"][key] for r in rows) / (2 * len(rows))) if rows else 0


def write_report(
    capture: Path, rows: list[dict[str, Any]], model_name: str
) -> list[dict[str, Any]]:
    """Write ``REPORT.md`` and ``review.json`` next to the capture; return the review items.

    A page/view is flagged when its first look (the 5-second read, or the 30-second read when no
    screenshot exists) conveys the offer to fewer than ``OFFER_THRESHOLD`` percent of the score.
    """
    scored = [
        r
        for r in rows
        if all(isinstance(r["score"].get(k), int) for k in ("offer", "audience", "next"))
    ]

    def group(path: str, view: str, exposure: str) -> list[dict[str, Any]]:
        return [
            r for r in scored if (r["path"], r["view"], r["exposure"]) == (path, view, exposure)
        ]

    keys = sorted({(r["path"], r["view"], r["exposure"]) for r in scored})
    lines = [
        "# Cold read",
        "",
        f"{len(scored)} scored reads of {len(rows)}, by: {model_name}. "
        "The readers are model proxies for strangers, not people. Each score is the share of the "
        "2-point maximum: 100 means every reader got it right.",
        "",
        "| page | view | read | offer | audience | next step | trust |",
        "|---|---|---|---|---|---|---|",
    ]
    for path, view, exposure in keys:
        rs = group(path, view, exposure)
        trust = [
            r["answer"].get("trust")
            for r in rs
            if isinstance(r["answer"].get("trust"), (int, float))
        ]
        average = round(sum(trust) / len(trust), 1) if trust else "-"
        offer, audience, step = (_percent(rs, k) for k in ("offer", "audience", "next"))
        lines.append(
            f"| {path} | {view} | {exposure} | {offer} | {audience} | {step} | {average} |"
        )
    lines += [
        "",
        f"Overall: offer {_percent(scored, 'offer')}, audience {_percent(scored, 'audience')}, "
        f"next step {_percent(scored, 'next')}.",
        "",
        "## What readers said",
        "",
    ]
    for r in scored:
        an = r["answer"]
        lines.append(
            f"- **{r['path']} {r['view']} {r['exposure']} / {r['persona']}**: "
            f'sells "{an.get("sells", "")}"; for "{an.get("for_whom", "")}"; '
            f'next "{an.get("next", "")}"; confused by "{an.get("confusing", "")}". '
            f"Judge: {r['score'].get('note', '')}"
        )
    (capture / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    items = []
    for path, view in sorted({(r["path"], r["view"]) for r in scored}):
        exposures = {r["exposure"] for r in scored if (r["path"], r["view"]) == (path, view)}
        first = "5s" if "5s" in exposures else "30s"
        rs = group(path, view, first)
        offer, step = _percent(rs, "offer"), _percent(rs, "next")
        if offer < OFFER_THRESHOLD:
            confusions = (str(r["answer"].get("confusing", ""))[:140] for r in rs)
            said = "; ".join(c for c in confusions if c and c.lower() != "nothing")
            items.append(
                {
                    "path": path,
                    "width": 1440 if view == "desktop" else 390,
                    "body": f"Cold read ({view}, {first}): offer understood {offer}%, "
                    f"next step {step}%." + (f" Readers said: {said}" if said else ""),
                }
            )
    (capture / "review.json").write_text(
        json.dumps({"source": "coldread", "items": items}, indent=2) + "\n", encoding="utf-8"
    )
    return items
