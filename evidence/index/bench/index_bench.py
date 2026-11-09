#!/usr/bin/env python3
"""AlcorIndex-style filename search benchmark: baseline scan versus SQLite FTS5 trigram, on a seeded public-synthetic corpus.

    python3 -B bench/index_bench.py --records N --seed S --workdir DIR [--rounds R] [--inject-fts-fault]

Writes only inside DIR: corpus.sqlite, queries.jsonl, manifest.json. Standard library only.
The corpus is invented (no real path, device or user name) and deterministic in (seed, records).
"""
import argparse
import bisect
import datetime
import hashlib
import operator
import json
import os
import random
import resource
import sqlite3
import subprocess
import sys
import time

SCHEMA = "index-bench/1"
QUERIES = 300
SPLIT = (("common", 60), ("rare", 60), ("multi_term", 50), ("filter", 50), ("case_variant", 30), ("no_match", 25), ("boundary", 25))
BASE_EPOCH = 1_730_000_000          # fixed reference "now" for mtime (no dependence on the wall clock)
SPAN = 4 * 365 * 86400
REPRO_QUICK = "python3 -B bench/index_bench.py --records 20000 --seed 20261108"
REPRO_FULL = "python3 -B bench/index_bench.py --records 1000000 --seed 20261108"

COMMON_DIRS = ["src", "lib", "build", "test", "tests", "docs", "data", "node_modules", "include", "assets", "config", "tmp", "cache",
               "release", "vendor", "scripts", "images", "output", "backup", "public"]
COMMON_STEMS = ["index", "main", "readme", "config", "util", "test", "data", "module", "report", "notes", "image", "setup", "log"]
EXTS = [(".py", 20), (".js", 14), (".md", 10), (".txt", 10), (".json", 9), (".png", 8), (".c", 6), (".h", 5), (".log", 5),
        (".csv", 4), (".html", 4), (".css", 3), ("", 6)]
SYL = ["ba", "ko", "ri", "tu", "ve", "lan", "mor", "dex", "pil", "sa", "ne", "gor", "fi", "wex", "zu", "qua", "hel", "jin", "or", "yo",
       "kra", "sto", "bri", "plu", "nem", "tal", "vor", "cin", "dra", "mus"]
ROOTS = ["vol", "disk", "store", "mnt", "pool"]
PLANTED = ["Mixed_Case%Report\"v2.TXT", "UPPER_NAME.PY", "a_b%c", "quote\"mark.md", "100%_done.log", "Dot.Name.Json", "x_y_z.c", "pct%sign.h"]


def sha_ids(ids):
    return hashlib.sha256(",".join(str(i) for i in sorted(ids)).encode()).hexdigest()


def esc_like(t):
    return t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ------------------------------------------------------------------ corpus
def make_vocab(rng):
    """Tail vocabulary: invented syllable words, drawn Zipf-like so a few are common and most are rare."""
    words = sorted({"".join(rng.choice(SYL) for _ in range(rng.choice((2, 2, 3)))) for _ in range(4000)})
    rng.shuffle(words)
    cum, t = [], 0.0
    for i in range(len(words)):
        t += 1.0 / (i + 1) ** 0.9
        cum.append(t)
    return words, cum


def gen_rows(records, seed):
    """Yield (id, kind, size, mtime, count, path, name) in id order; also fills stats for query planning."""
    rng = random.Random(seed)
    words, cum = make_vocab(rng)
    ext_names = [e for e, _ in EXTS]
    ext_cum = []
    t = 0
    for _, w in EXTS:
        t += w
        ext_cum.append(t)
    freq = {}
    stats = {"words": words, "freq": freq}

    def tail():
        w = rng.choices(words, cum_weights=cum)[0]
        freq[w] = freq.get(w, 0) + 1
        return w

    def dword():
        return rng.choice(COMMON_DIRS) if rng.random() < 0.6 else tail()

    def rows():
        for i in range(1, records + 1):
            r = rng.random()
            depth = min(12, 2 + int(rng.expovariate(0.45)))
            parts = [rng.choice(ROOTS) + str(rng.randrange(1, 9))] + [dword() for _ in range(depth - 1)]
            if rng.random() < 0.002:
                name = rng.choice(PLANTED)
                kind = "f"
            elif r < 0.78 or r >= 0.96:
                kind = "f" if r < 0.78 else ("x" if r < 0.985 else "l")
                if kind == "f":
                    stem = rng.choice(COMMON_STEMS) if rng.random() < 0.5 else tail()
                    suffix = str(rng.randrange(0, 1000)) if rng.random() < 0.6 else ""
                    ext = ext_names[bisect.bisect(ext_cum, rng.randrange(t))]
                    name = stem + ("_" if suffix and rng.random() < 0.3 else "") + suffix + ext
                else:
                    name = dword() + str(rng.randrange(0, 100))
            elif r < 0.90:
                kind, name = "d", dword() + str(rng.randrange(0, 50))
            else:
                kind, name = "b", ""
            if kind == "b":
                exts = rng.sample(ext_names[:-1], 2)
                cnt = rng.randrange(2001, 90000)
                path = "/" + "/".join(parts) + "/[" + ",".join(f"{e}:{rng.randrange(1, cnt)}" for e in exts) + "]"
                size, count = int(rng.lognormvariate(16, 1.5)), cnt
            else:
                path = "/" + "/".join(parts) + "/" + name
                size = int(rng.lognormvariate(9, 2.0)) if kind == "f" else 0
                count = 0
            mtime = 0 if (kind == "l" and rng.random() < 0.3) else BASE_EPOCH - rng.randrange(SPAN)
            yield (i, kind, size, mtime, count, path, path.rstrip("/").rsplit("/", 1)[-1])

    return rows(), stats


def build_db(path, records, seed):
    """Fill files, build fts exactly as AlcorIndex does. Returns (dataset_sha256, stats, build_seconds)."""
    t0 = time.perf_counter()
    for suffix in ("", "-journal", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("PRAGMA synchronous=OFF")
    con.execute("PRAGMA page_size=8192")
    con.execute("CREATE TABLE files(id INTEGER PRIMARY KEY, kind TEXT, size INTEGER, mtime INTEGER, count INTEGER, path TEXT, name TEXT)")
    rows, stats = gen_rows(records, seed)
    h = hashlib.sha256()
    batch = []
    for row in rows:
        h.update(("\t".join(str(c) for c in row) + "\n").encode())
        batch.append(row)
        if len(batch) >= 50000:
            con.executemany("INSERT INTO files VALUES(?,?,?,?,?,?,?)", batch)
            batch = []
    if batch:
        con.executemany("INSERT INTO files VALUES(?,?,?,?,?,?,?)", batch)
    con.commit()
    con.execute("CREATE VIRTUAL TABLE fts USING fts5(name, path, content='files', content_rowid='id', tokenize='trigram')")
    con.execute("INSERT INTO fts(fts) VALUES('rebuild')")
    con.execute("CREATE INDEX files_mtime ON files(mtime)")
    con.commit()
    con.close()
    return h.hexdigest(), stats, time.perf_counter() - t0


# ------------------------------------------------------------------ queries
def mixcase(rng, t):
    return "".join(c.upper() if rng.random() < 0.5 else c for c in t) if rng.random() < 0.7 else t.upper()


def plan_queries(seed, stats):
    rng = random.Random(seed * 7919 + 13)
    words, freq = stats["words"], stats["freq"]
    rare = sorted(w for w, n in freq.items() if 1 <= n <= 40 and len(w) >= 3)
    mid = sorted(w for w, n in freq.items() if 40 < n and len(w) >= 3)
    common = [d for d in COMMON_DIRS if len(d) >= 3] + COMMON_STEMS[:4] + [".py", ".js", "vol", "disk"]
    rare = rare or words
    mid = mid or words
    short = ["a", "e", "s", "i", "/", ".", "ba", "ko", "ri", "te", "sr", "li", "_", "1", "0", "py", "js", "md"]
    ker = ["py", "js", "md", "txt", "json", "png", "c", "h", "log", "csv", ".PY", "Json"]
    kinds = ["f", "d", "l", "b", "x"]
    qs = []

    def add(cat, terms, kind=None, ext=None, since=None):
        qs.append({"id": f"q{len(qs) + 1:03d}", "category": cat, "terms": terms, "kind": kind, "ext": ext, "since_mtime": since})

    def any_term():
        return rng.choice((rng.choice(common), rng.choice(mid), rng.choice(rare), rng.choice(short)))

    for cat, n in SPLIT:
        for k in range(n):
            if cat == "common":
                add(cat, [rng.choice(common if k % 3 else mid)])
            elif cat == "rare":
                add(cat, [rng.choice(rare)])
            elif cat == "multi_term":
                add(cat, [any_term() for _ in range(rng.randrange(2, 5))])
            elif cat == "filter":
                terms = [rng.choice(common + mid + rare)]
                f = k % 4
                add(cat, terms, kind=rng.choice(kinds) if f in (0, 3) else None, ext=rng.choice(ker) if f in (1, 3) else None,
                    since=BASE_EPOCH - rng.randrange(SPAN) if f in (2, 3) else None)
            elif cat == "case_variant":
                add(cat, [mixcase(rng, rng.choice(common + mid + rare))])
            elif cat == "no_match":
                add(cat, [rng.choice(["#", "~", "qxj", "zzq", "wvx"]) + "".join(rng.choice("0123456789") for _ in range(rng.randrange(2, 5)))])
            else:
                b = k % 5
                if b == 0:
                    add(cat, [rng.choice(["a", "e", "_", "%", "\"", "/", ".", "[", "1", ":"])])
                elif b == 1:
                    add(cat, [rng.choice(["ba", "ko", "a_", "_b", "%_", "t%", "e\"", ".p", "x_", "c%", "[.", "s/"])])
                elif b == 2:
                    add(cat, [rng.choice(["_Case", "%Rep", "\"v2", "100%", "a_b%", "e\"m", "t_Case", "Dot.", "x_y_", "pct%", "mark.", "ort\"v"])])
                elif b == 3:
                    add(cat, [rng.choice(["_", "%", "\"", "a", "ko"]), rng.choice(["src", "py", "lib", "e"])], kind=rng.choice(["f", None]))
                else:
                    add(cat, [rng.choice(["Q\"", "Mixed_", "%", "_"]), rng.choice(common)], ext=rng.choice(["txt", "py", None]))
    return qs


def load_rows(con):
    ids, kinds, mt, low, names = [], [], [], [], []
    for i, k, m, p, n in con.execute("SELECT id, kind, mtime, path, name FROM files ORDER BY id"):
        ids.append(i); kinds.append(k); mt.append(m); low.append(p.lower()); names.append(n.lower())
    return ids, kinds, mt, low, names


def make_scan(data):
    ids, kinds, mt, low, names = data

    def scan(q):
        idx = range(len(ids))
        for t in q["terms"]:
            t = t.lower()
            idx = [i for i in idx if t in low[i]]
        if q["kind"]:
            idx = [i for i in idx if kinds[i] == q["kind"]]
        if q["ext"]:
            e = q["ext"].lower()
            e = e if e.startswith(".") else "." + e
            idx = [i for i in idx if names[i].endswith(e)]
        if q["since_mtime"] is not None:
            idx = [i for i in idx if mt[i] >= q["since_mtime"]]
        return [ids[i] for i in idx]

    return scan


_first = operator.itemgetter(0)


def make_fts(con):
    def fts(q):
        where, args = [], []
        for t in q["terms"]:
            if len(t) < 3:
                where.append("f.path LIKE ? ESCAPE '\\'")
                args.append("%" + esc_like(t) + "%")
        if q["kind"]:
            where.append("f.kind = ?")
            args.append(q["kind"])
        if q["ext"]:
            where.append("f.name LIKE ? ESCAPE '\\'")
            args.append("%" + esc_like(q["ext"] if q["ext"].startswith(".") else "." + q["ext"]))
        if q["since_mtime"] is not None:
            where.append("f.mtime >= ?")
            args.append(q["since_mtime"])
        w = "".join(" AND " + x for x in where)
        long_t = [t for t in q["terms"] if len(t) >= 3]
        if long_t:
            m = " AND ".join('"' + t.replace('"', '""') + '"' for t in long_t)
            if not where:
                # content_rowid is files.id, so the join adds no filter here; read the rowid directly.
                return list(map(_first, con.execute("SELECT rowid FROM fts WHERE fts MATCH ?", [m]).fetchall()))
            return list(map(_first, con.execute("SELECT f.id FROM fts JOIN files f ON f.id = fts.rowid WHERE fts MATCH ?" + w, [m] + args).fetchall()))
        return list(map(_first, con.execute("SELECT f.id FROM files f WHERE 1=1" + w, args).fetchall()))

    return fts


def pct(vals, p):
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, round((len(s) - 1) * p)))]


# ------------------------------------------------------------------ environment facts
def hardware():
    cpu, ram = "unknown", 0.0
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
        if cpu == "unknown":
            for line in open("/proc/cpuinfo"):
                if line.split(":")[0].strip() in ("Model", "Hardware", "CPU part"):
                    cpu = line.split(":", 1)[1].strip()
                    break
        for line in open("/proc/meminfo"):
            if line.startswith("MemTotal"):
                ram = round(int(line.split()[1]) / 1048576, 1)
                break
    except OSError:
        pass
    return {"cpu_model": cpu, "cores": os.cpu_count() or 1, "ram_gb": ram}


def source_commit():
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        out = subprocess.run(["git", "-C", here, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=30).stdout.strip()
        if len(out) == 40 and all(c in "0123456789abcdef" for c in out):
            return out
    except (OSError, subprocess.SubprocessError):
        pass
    return "unavailable (not a git checkout of the original harness repo)"


def alcor_index_sha():
    root = os.environ.get("ALCOR_ROOT")
    if not root:
        return "unavailable (original AlcorIndex source is not part of this repo)"
    try:
        with open(os.path.join(root, "AlcorIndex", "alcor_index.py"), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError as e:
        return "unavailable (original AlcorIndex source is not part of this repo)"


def fts_bytes(path):
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        n = con.execute("SELECT sum(pgsize) FROM dbstat WHERE name LIKE 'fts\\_%' ESCAPE '\\'").fetchone()[0]
        con.close()
        if n:
            return int(n)
    except sqlite3.Error:
        pass
    return os.path.getsize(path)


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--records", type=int, required=True)
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--workdir", required=True, help="existing directory; everything is written here")
    ap.add_argument("--rounds", type=int, default=5, help="timed rounds per query (at least 3)")
    ap.add_argument("--warmup-rounds", type=int, default=1)
    ap.add_argument("--inject-fts-fault", action="store_true", help="drop one hit from the FTS side of one query (mismatch must be detected)")
    a = ap.parse_args()
    if a.records < 1000 or a.rounds < 3 or a.warmup_rounds < 1:
        sys.exit("index_bench: need --records >= 1000, --rounds >= 3, --warmup-rounds >= 1")
    work = os.path.abspath(a.workdir)
    if not os.path.isdir(work):
        sys.exit("index_bench: --workdir must be an existing directory")
    os.environ["SQLITE_TMPDIR"] = work
    commit, idx_sha = source_commit(), alcor_index_sha()
    db = os.path.join(work, "corpus.sqlite")

    dataset_sha, stats, build_s = build_db(db, a.records, a.seed)
    qs = plan_queries(a.seed, stats)
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    scan, fts = make_scan(load_rows(con)), make_fts(con)

    # untimed pass: results for identity checking; this is also warm-up round 1
    fault_done, injected_id = False, None
    for q in qs:
        s, f = scan(q), fts(q)
        if a.inject_fts_fault and not fault_done and f:
            f = f[:-1]
            fault_done = True
            injected_id = q["id"]
        q["scan_n"], q["fts_n"] = len(s), len(f)
        q["scan_ids_sha256"], q["fts_ids_sha256"] = sha_ids(s), sha_ids(f)
        q["scan_ms"], q["fts_ms"] = [], []
    if a.inject_fts_fault and not fault_done:
        sys.exit("index_bench: --inject-fts-fault found no query with hits to corrupt")
    for _ in range(a.warmup_rounds - 1):
        for q in qs:
            scan(q); fts(q)
    for _ in range(a.rounds):
        for q in qs:
            t = time.perf_counter(); scan(q); q["scan_ms"].append((time.perf_counter() - t) * 1000)
            t = time.perf_counter(); fts(q); q["fts_ms"].append((time.perf_counter() - t) * 1000)
    con.close()

    bad = [q for q in qs if q["scan_ids_sha256"] != q["fts_ids_sha256"] or q["scan_n"] != q["fts_n"]]
    with open(os.path.join(work, "queries.jsonl"), "w") as f:
        for q in qs:
            f.write(json.dumps(q) + "\n")
    side = lambda key: {"warm_p50_ms": pct([x for q in qs for x in q[key]], 0.5), "warm_p95_ms": pct([x for q in qs for x in q[key]], 0.95)}
    mf = {
        "schema": SCHEMA,
        "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        "seed": a.seed, "records": a.records, "dataset_kind": "public-synthetic", "queries": len(qs),
        "mismatches": len(bad),
        "baseline_scan": side("scan_ms"), "fts": side("fts_ms"),
        "index_size_bytes": fts_bytes(db), "corpus_file_bytes": os.path.getsize(db),
        "build_seconds": round(build_s, 3),
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "hardware": hardware(),
        "reproduce_quick": REPRO_QUICK, "reproduce_full": REPRO_FULL,
        "source_commit": commit, "alcor_index_sha256": idx_sha, "dataset_sha256": dataset_sha,
        "query_classes": {c: sum(1 for q in qs if q["category"] == c) for c, _ in SPLIT},
        "rounds": a.rounds, "warmup_rounds": a.warmup_rounds, "raw_files": ["queries.jsonl"],
        "semantics": ("Every term is a literal, case-insensitive substring of the row path, all terms AND-ed. FTS arm: terms of 3 or more "
                      "characters are quoted phrases ANDed in one MATCH on the FTS5 trigram index (name, path); terms of 1-2 characters use "
                      "path LIKE '%term%' ESCAPE '\\' with backslash, percent and underscore escaped. Filters: kind equality, ext as "
                      "name LIKE '%.ext' (escaped), since_mtime as mtime >= N. Baseline arm: the same semantics as plain lower-cased "
                      "substring tests in Python over the files rows, no FTS table. Compared: the full unlimited set of row ids, before "
                      "any ranking or limit."),
        "limitations": ("Synthetic ASCII corpus with invented words, not real file trees. Ranking, bm25 and result limits are not "
                        "benchmarked. Baseline scan is an in-memory Python loop over preloaded rows; FTS runs through sqlite3 from disk "
                        "pages (page cache warm after warm-up). Warm-cache timings only; caches are never dropped. index_size_bytes is the "
                        "size of the fts shadow tables (whole-file size if dbstat is unavailable). Non-ASCII case folding is not exercised."),
    }
    if bad:
        real = [q["id"] for q in bad if q["id"] != injected_id]
        note = f"{len(bad)} of {len(qs)} queries returned different id sets from the baseline scan and FTS: " + ", ".join(q["id"] for q in bad[:10]) + ". "
        if injected_id:
            note += f"Query {injected_id} was corrupted deliberately by --inject-fts-fault (one FTS hit dropped). "
            note += f"Other mismatches are real findings, not masked: {', '.join(real[:10])}." if real else "No other mismatches."
        else:
            note += "Real finding; not masked."
        mf["mismatch_note"] = note
    with open(os.path.join(work, "manifest.json"), "w") as f:
        json.dump(mf, f, indent=2)
        f.write("\n")
    print(f"records={a.records} seed={a.seed} mismatches={len(bad)} scan_p50={mf['baseline_scan']['warm_p50_ms']:.3f}ms "
          f"fts_p50={mf['fts']['warm_p50_ms']:.3f}ms")


if __name__ == "__main__":
    main()
