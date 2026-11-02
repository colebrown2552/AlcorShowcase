"""Memory that cannot be talked into believing something.

Two ideas keep the agent's memory honest:

**Where a claim came from decides what it is.** ``remember`` files an observation, and
``memory.alcor`` names the admission from facts the host can check. A row that cites evidence is
*stamped* with the evidence's hash. A row that merely echoes what someone just told the agent is
*testimony*, attributed to its speaker, never the agent's own observation. A row that claims a
result ("verified", "passes") with no evidence is *refused*, with the reason to cite the check. Any
other row is kept, marked *unsourced*.

**Lessons are staged, never self-admitted.** A drafted lesson passes a shape check, then
``cli.alcor`` may stage it. Only an operator command, which sets ``owner_confirmed=true``, admits
it into memory. Nothing the agent produces can set that cell.

The ledger itself is hash-chained, so editing or deleting a row is detectable.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .config import Scope
from .digest import sha256_hex, utc_iso
from .errors import PolicyError, ReceiptError
from .fsutil import atomic_replace
from .policy import PolicyHost
from .portable_lock import sidecar_lock
from .receipts import ReceiptLog
from .routing import cli_decide
from .tools import ToolSpec

MEMORY_PROGRAM = "memory"
MEMORY_REQUEST_SCHEMA = "alcor.cli.memory.request.v1"
MEMORY_DECISION_SCHEMA = "alcor.cli.memory.decision.v1"

LESSON_FIELDS = ("RULE", "BECAUSE", "TOPIC")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_WORD = re.compile(r"[a-z][a-z0-9_]{2,}")
_STOP = frozenset(
    {
        *("the", "and", "that", "this", "with", "for", "you", "your", "was", "were", "are"),
        *("have", "has", "not", "but", "from", "into", "his", "its", "all", "one", "did"),
        *("can", "our"),
    }
)
# A sentence that claims a result. With no evidence cited, such a row is refused.
_CLAIMS = re.compile(
    r"\b(confirmed|verified|proven|passes|passed|works|is running|succeeded"
    r"|completed successfully)\b",
    re.I,
)


def _tokens(text: str) -> set[str]:
    return set(_WORD.findall(text.lower())) - _STOP


class MemoryLedger:
    """An append-only, hash-chained list of memory rows.

    It reuses the receipt log's chain, so editing or deleting a row breaks every id after it.

    Args:
        path: The ledger file.
    """

    def __init__(self, path: Path | str) -> None:
        self.log = ReceiptLog(path)

    def add(
        self,
        kind: str,
        text: str,
        *,
        topic: str = "",
        source: str = "agent",
        extra: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one row and return it flattened (``id``, ``utc``, ``kind``, ``text``, ...)."""
        body = {"kind": kind, "text": text, "topic": topic, "source": source, **(extra or {})}
        row = self.log.append(f"memory.{kind}", body)
        return {"id": row["id"], "utc": row["utc"], **row["body"]}

    def entries(self) -> list[dict[str, Any]]:
        """Every row, oldest first, flattened."""
        return [{"id": r["id"], "utc": r["utc"], **r["body"]} for r in self.log.rows()]

    def verify_chain(self) -> tuple[bool, str]:
        """Return ``(ok, reason)`` for the whole ledger."""
        report = self.log.verify()
        return bool(report["ok"]), str(report["reason"])

    def search(self, query: str, k: int = 5) -> list[dict[str, Any]]:
        """Return the ``k`` rows that best match ``query``.

        The score is the number of query words a row shares, weighted by how rare each word is in
        the ledger, with lessons counting double. Ties go to the newer row. Deterministic.
        """
        wanted = _tokens(query)
        rows = self.entries()
        if not wanted or not rows:
            return []
        row_tokens = [_tokens(f"{r.get('text', '')} {r.get('topic', '')}") for r in rows]
        frequency = {word: sum(word in tokens for tokens in row_tokens) for word in wanted}
        scored = []
        for index, (row, tokens) in enumerate(zip(rows, row_tokens, strict=True)):
            score = sum(1.0 / (1 + frequency[w]) for w in wanted & tokens)
            if score:
                scored.append((score * (2.0 if row.get("kind") == "lesson" else 1.0), index, row))
        scored.sort(key=lambda item: (-item[0], -item[1]))
        return [row for _, _, row in scored[: max(1, min(int(k), 20))]]

    def recall(self, query: str, budget_chars: int = 1400) -> str:
        """Return the best-matching rows as prose, within ``budget_chars``."""
        lines: list[str] = []
        used = 0
        for row in self.search(query, k=8):
            tag = row.get("admission") or row.get("kind")
            line = f"- [{tag}] {str(row.get('text', ''))[:400]}"
            if used + len(line) > budget_chars:
                break
            lines.append(line)
            used += len(line)
        return "\n".join(lines)


def parse_lesson(text: str) -> tuple[str, dict[str, str], str]:
    """Check the shape of a drafted lesson: three labelled lines, fixed order, then ``END``.

    A model that free-associates a "lesson" produces something that reads fine and cannot be
    acted on. Shape is checked here, in the host, before the program is asked to stage it.

    Returns:
        ``(state, fields, detail)`` where state is ``typed`` or ``invalid``.
    """
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    if lines and lines[-1].upper() == "END":
        lines = lines[:-1]
    if len(lines) != len(LESSON_FIELDS):
        return "invalid", {}, f"line-count:{len(lines)}"
    fields: dict[str, str] = {}
    for name, line in zip(LESSON_FIELDS, lines, strict=True):
        head, separator, rest = line.partition(":")
        if head.strip().upper() != name or not separator:
            return "invalid", {}, f"field-order:{head.strip()[:24]}"
        fields[name] = rest.strip()
    if not 12 <= len(fields["RULE"]) <= 220:
        return "invalid", fields, "rule-shape"
    if len(fields["BECAUSE"]) < 12:
        return "invalid", fields, "because-shape"
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", fields["TOPIC"]):
        return "invalid", fields, "topic-shape"
    return "typed", fields, ""


class Memory:
    """Admission, recall and lesson staging over one ledger.

    Args:
        ledger: The hash-chained memory ledger.
        policy: The policy host that runs ``memory.alcor`` and ``cli.alcor``.
        heard_path: Where claims made *to* the agent are kept, so they are not later recorded
            as the agent's own observations.
        pending_path: Where staged lessons wait for the operator.
        receipts: Admissions are recorded here as hashes, never as text.
        scope: Used to stamp evidence that names a file.
    """

    def __init__(
        self,
        ledger: MemoryLedger,
        policy: PolicyHost,
        *,
        heard_path: Path,
        pending_path: Path,
        receipts: ReceiptLog | None = None,
        scope: Scope | None = None,
    ) -> None:
        self.ledger = ledger
        self.policy = policy
        self.heard_path = Path(heard_path)
        self.pending_path = Path(pending_path)
        self.receipts = receipts
        self.scope = scope

    # -- who said it ---------------------------------------------------------------------------

    def note_heard(self, actor: str, text: str) -> dict[str, Any]:
        """Register what someone said *to* the agent, before it can become a row about itself.

        Told a flattering result it could not check, an agent will write it into its ledger as
        its own observation and invent a method for it. So every task text, relay message and API
        intent is noted here first, and ``remember`` files a matching claim as testimony
        attributed to its speaker.
        """
        body = str(text or "").strip()
        if not body:
            return {"ok": False, "why": "empty"}
        row = {
            "actor": str(actor or "unknown")[:40],
            "text_sha256": sha256_hex(body),
            "numbers": sorted(set(_NUMBER.findall(body)))[:20],
            "words": sorted(_tokens(body))[:200],
        }
        try:
            with sidecar_lock(self.heard_path):
                self.heard_path.parent.mkdir(parents=True, exist_ok=True)
                with self.heard_path.open("a", encoding="utf-8", newline="\n") as handle:
                    handle.write(json.dumps(row, sort_keys=True) + "\n")
        except OSError as exc:
            return {"ok": False, "why": type(exc).__name__}
        return {"ok": True, "actor": row["actor"], "numbers": row["numbers"]}

    def _recent_heard(self, limit: int = 40) -> list[dict[str, Any]]:
        try:
            lines = self.heard_path.read_text(encoding="utf-8").splitlines()[-limit:]
        except OSError:
            return []
        rows = []
        for line in lines:
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        return rows

    def attributed(self, text: str) -> dict[str, str] | None:
        """Return the claim this text echoes, if any was said to the agent.

        An echo is a shared number, or at least half the content words.
        """
        body = str(text or "").lower()
        numbers, words = set(_NUMBER.findall(body)), _tokens(body)
        for row in reversed(self._recent_heard()):
            seen_numbers, seen_words = set(row.get("numbers") or []), set(row.get("words") or [])
            if numbers and numbers & seen_numbers:
                return {"actor": str(row.get("actor")), "by": "number"}
            if len(words) >= 4 and seen_words and len(words & seen_words) * 2 >= len(words):
                return {"actor": str(row.get("actor")), "by": "words"}
        return None

    # -- what backs it -------------------------------------------------------------------------

    def stamp(self, evidence: str) -> dict[str, str]:
        """Hash the evidence a row cites, or raise ``ValueError`` if it cannot be resolved.

        ``receipt:<id>`` must name a receipt that exists. A path to a file inside the scope is
        hashed by content. Any other text is hashed as the transcript of a check. The stamp
        proves *what was cited*, not that the citation is true.
        """
        ref = str(evidence).strip()
        if ref.startswith("receipt:"):
            found = self.receipts.find(ref[len("receipt:") :].strip()) if self.receipts else None
            if found is None:
                raise ValueError("receipt-not-found")
            return {"sha256": found["id"], "ref": ref[:200], "kind": "receipt"}
        if self.scope is not None and len(ref) < 260 and "\n" not in ref:
            try:
                if self.scope.contains(ref) and self.scope.resolve(ref).is_file():
                    data = self.scope.resolve(ref).read_bytes()
                    return {
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "ref": self.scope.display(ref),
                        "kind": "file",
                    }
            except (OSError, ValueError):
                pass
        return {"sha256": sha256_hex(ref), "ref": ref[:200], "kind": "text"}

    def _admission(
        self,
        *,
        has_evidence: bool,
        evidence_failed: bool,
        echoes_heard: bool,
        asserts_result: bool,
    ) -> dict[str, str]:
        """Consult ``memory.alcor``. Unavailable is refuse: an unjudged row is not written."""
        cells = {
            "schema": MEMORY_REQUEST_SCHEMA,
            "effect_authority": "false",
            "has_evidence": "yes" if has_evidence else "no",
            "evidence_failed": "yes" if evidence_failed else "no",
            "echoes_heard": "yes" if echoes_heard else "no",
            "asserts_result": "yes" if asserts_result else "no",
        }
        try:
            return dict(self.policy.decide(MEMORY_PROGRAM, cells, MEMORY_DECISION_SCHEMA).fields)
        except PolicyError as exc:
            return {"kind": "refuse", "reason": f"memory-program-unavailable: {exc.code}"}

    def _receipt(self, kind: str, body: Mapping[str, Any]) -> None:
        if self.receipts is None:
            return
        # The ledger row carries its own chained id; a missed receipt is not a missed row.
        with contextlib.suppress(ReceiptError):
            self.receipts.append(kind, body)

    # -- the tools -----------------------------------------------------------------------------

    def remember(self, text: str, topic: str = "", evidence: str = "") -> dict[str, Any]:
        """File an observation, let ``memory.alcor`` name its admission, and read it back."""
        body = str(text or "").strip()
        if len(body) < 12:
            return {"ok": False, "error": "an observation needs at least 12 characters"}
        if len(body) > 4000:
            return {"ok": False, "error": "an observation may not exceed 4000 characters"}
        extra: dict[str, Any] = {}
        status = "unsourced"
        if str(evidence or "").strip():
            try:
                stamped = self.stamp(evidence)
                extra = {"evidence_sha256": stamped["sha256"], "evidence_ref": stamped["ref"]}
                extra["evidence_kind"] = stamped["kind"]
                status = "stamped"
            except ValueError as exc:
                extra = {"evidence_ref": str(evidence)[:200], "evidence_error": str(exc)[:80]}
                status = "evidence_unstamped"
        heard = None if status == "stamped" else self.attributed(body)
        decided = self._admission(
            has_evidence=status == "stamped",
            evidence_failed=status == "evidence_unstamped",
            echoes_heard=bool(heard),
            asserts_result=bool(_CLAIMS.search(body)),
        )
        if decided.get("kind") == "refuse":
            self._receipt("memory.refused", {"reason": decided.get("reason"), "topic": topic[:48]})
            return {
                "ok": False,
                "status": "refused",
                "admission": "refused",
                "reason": decided.get("reason"),
                "program": "memory.alcor",
            }
        status = str(decided.get("kind") or status)
        row_topic = str(topic or "")[:48]
        if heard and status == "testimony":
            row_topic = "testimony"
            extra.update(
                {
                    "attributed_to": heard["actor"],
                    "matched_by": heard["by"],
                    "original_topic": str(topic or "")[:48],
                }
            )
        extra["admission"] = status
        extra["admission_reason"] = str(decided.get("reason") or "")[:80]
        before = len(self.ledger.entries())
        row = self.ledger.add("observation", body, topic=row_topic, source="agent", extra=extra)
        after = self.ledger.entries()
        landed = any(entry.get("id") == row["id"] for entry in after[-5:])
        chain_ok, why = self.ledger.verify_chain()
        self._receipt(
            "memory.admitted",
            {
                "id": row["id"],
                "admission": status,
                "text_sha256": sha256_hex(body),
                "evidence_sha256": extra.get("evidence_sha256"),
                "entries_after": len(after),
            },
        )
        return {
            "ok": bool(landed and chain_ok),
            "id": row["id"],
            "admission": status,
            **({"attributed_to": heard["actor"]} if heard else {}),
            "entries_before": before,
            "entries_after": len(after),
            # Proof, not assertion: the row was found by re-reading, and the chain still verifies.
            "found_by_rereading": landed,
            "chain_intact": chain_ok,
            **({} if chain_ok else {"chain_error": why[:120]}),
        }

    def recall(self, query: str, k: int = 5, budget_chars: int = 1200) -> dict[str, Any]:
        """Read the ledger on demand: the rows nearest a query, each saying what it is."""
        text = str(query or "").strip()
        if len(text) < 2:
            return {"ok": False, "error": "recall needs a query"}
        hits = [
            {key: row.get(key) for key in ("id", "utc", "kind", "topic", "source", "admission")}
            | {"text": str(row.get("text", ""))[:400]}
            for row in self.ledger.search(text[:400], k=k)
        ]
        return {
            "ok": True,
            "query": text[:400],
            "hits": hits,
            "recalled": self.ledger.recall(
                text[:400], budget_chars=max(200, min(budget_chars, 4000))
            ),
            "status": "found" if hits else "nothing_near",
        }

    def specs(self) -> tuple[ToolSpec, ...]:
        """The ``remember`` and ``recall`` tools."""
        return (
            ToolSpec(
                name="recall",
                description=(
                    "Look something up in your own ledger: the rows nearest the query, each with "
                    "its kind, topic and admission (stamped, testimony, unsourced). Read-only."
                ),
                handler=lambda a: self.recall(str(a.get("query") or ""), int(a.get("k") or 5)),
                parameters={
                    "type": "object",
                    "properties": {"query": {"type": "string"}, "k": {"type": "integer"}},
                    "required": ["query"],
                },
            ),
            ToolSpec(
                name="remember",
                description=(
                    "Write an observation into your own ledger. Returns the entry id found by "
                    "re-reading the ledger, and whether the hash chain still verifies. Cite what "
                    "you checked in `evidence`; a claimed result with no evidence is refused."
                ),
                handler=lambda a: self.remember(
                    str(a.get("text") or ""),
                    str(a.get("topic") or ""),
                    str(a.get("evidence") or ""),
                ),
                mutating=True,
                parameters={
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "topic": {"type": "string"},
                        "evidence": {
                            "type": "string",
                            "description": "a file path, a command and its output, or receipt:<id>",
                        },
                    },
                    "required": ["text"],
                },
            ),
        )

    # -- lessons -------------------------------------------------------------------------------

    def _pending(self) -> list[dict[str, Any]]:
        rows = []
        if self.pending_path.is_file():
            for line in self.pending_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        continue
        return rows

    def _save_pending(self, rows: list[dict[str, Any]]) -> None:
        self.pending_path.parent.mkdir(parents=True, exist_ok=True)
        body = "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows)
        atomic_replace(self.pending_path, body.encode("utf-8"))

    def propose(self, draft: str, *, clock: float) -> dict[str, Any]:
        """Stage a drafted lesson. It is **not** in memory until the operator admits it."""
        state, fields, detail = parse_lesson(draft)
        decision = cli_decide(
            self.policy,
            "cli-propose",
            memory_state="ready",
            owner_confirmed="false",
            lesson_state=state,
        )
        if decision.get("accepted") != "true":
            return {"ok": False, "reason": decision.get("reason"), "detail": detail}
        with sidecar_lock(self.pending_path):
            rows = self._pending()
            lesson_id = "p-" + sha256_hex(fields["RULE"] + fields["TOPIC"])[:10]
            if any(r.get("id") == lesson_id and r.get("state") == "pending" for r in rows):
                return {"ok": True, "id": lesson_id, "staged": True, "duplicate": True}
            rows.append(
                {
                    "id": lesson_id,
                    "rule": fields["RULE"],
                    "because": fields["BECAUSE"],
                    "topic": fields["TOPIC"],
                    "staged_at": utc_iso(clock),
                    "state": "pending",
                }
            )
            self._save_pending(rows)
        self._receipt(
            "memory.lesson-staged", {"id": lesson_id, "owner_action": decision.get("owner_action")}
        )
        return {
            "ok": True,
            "id": lesson_id,
            "staged": True,
            "in_memory": False,
            "owner_action": decision.get("owner_action"),
        }

    def lessons(self) -> list[dict[str, Any]]:
        """The lessons that are waiting for the operator."""
        return [row for row in self._pending() if row.get("state") == "pending"]

    def admit(self, lesson_id: str, *, clock: float) -> dict[str, Any]:
        """Admit a staged lesson into memory.

        ``owner_confirmed`` is true only because an operator typed this command with this id.
        Nothing the agent produces can set it, which is the whole point.
        """
        with sidecar_lock(self.pending_path):
            rows = self._pending()
            match = next(
                (r for r in rows if r.get("id") == lesson_id and r.get("state") == "pending"), None
            )
            if match is None:
                return {"ok": False, "reason": "no-such-pending-lesson"}
            decision = cli_decide(
                self.policy,
                "cli-admit",
                memory_state="ready",
                owner_confirmed="true",
                lesson_state="typed",
            )
            if decision.get("accepted") != "true" or decision.get("memory") != "write":
                return {"ok": False, "reason": decision.get("reason")}
            text = f"{match['rule']} BECAUSE: {match['because']}"
            row = self.ledger.add(
                "lesson", text, topic=match.get("topic", "cli"), source="proposed"
            )
            match.update(state="admitted", ledger_id=row["id"], admitted_at=utc_iso(clock))
            self._save_pending(rows)
        self._receipt("memory.lesson-admitted", {"id": lesson_id, "ledger_id": row["id"]})
        return {"ok": True, "id": lesson_id, "ledger_id": row["id"], "in_memory": True}

    def reject(self, lesson_id: str, *, clock: float) -> dict[str, Any]:
        """Reject a staged lesson. It never enters memory."""
        with sidecar_lock(self.pending_path):
            rows = self._pending()
            match = next(
                (r for r in rows if r.get("id") == lesson_id and r.get("state") == "pending"), None
            )
            if match is None:
                return {"ok": False, "reason": "no-such-pending-lesson"}
            match.update(state="rejected", rejected_at=utc_iso(clock))
            self._save_pending(rows)
        return {"ok": True, "id": lesson_id, "in_memory": False}
