"""Acceptance check: updates and deletes are visible immediately; the cache still works."""
import os
import subprocess
import sys


def clean_env(code_dir):
    """Minimal environment for running code from ``code_dir`` (nothing inherited but PATH)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": code_dir,
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}

PROBE = r'''
import os, sys
sys.path.insert(0, os.getcwd())
from shortener.service import LinkService
from shortener.store import LinkStore

fails = []

class CountingStore(LinkStore):
    def __init__(self):
        super().__init__()
        self.gets = 0
    def get(self, code):
        self.gets += 1
        return super().get(code)

def step(label, fn):
    try:
        fn()
    except Exception as e:
        fails.append(f"{label}: {type(e).__name__}: {e}")

def gone(svc, code):
    try:
        svc.resolve(code)
        return False
    except KeyError:
        return True

def update_other_case():
    svc = LinkService(store=CountingStore())
    svc.shorten("https://shop.example/spring-2025", code="Spring-Sale")
    svc.resolve("spring-sale")
    svc.update_target("SPRING-SALE", "https://shop.example/spring-2026")
    got = svc.resolve("Spring-Sale")
    if got != "https://shop.example/spring-2026":
        fails.append(f"after update_target with different case, resolve gave {got}")
    svc.update_target("  spring-sale ", "https://shop.example/final")
    got = svc.resolve("SPRING-sale")
    if got != "https://shop.example/final":
        fails.append(f"after update_target with padded code, resolve gave {got}")
step("update with another spelling", update_other_case)

def update_uncached():
    svc = LinkService()
    svc.shorten("https://a.example/1", code="Q3-report")
    svc.update_target("Q3-REPORT", "https://a.example/2")
    if svc.resolve("q3-report") != "https://a.example/2":
        fails.append("update_target on a never-resolved link not visible")
step("update before any resolve", update_uncached)

def delete_cached():
    svc = LinkService()
    svc.shorten("https://b.example/x", code="Promo")
    svc.resolve("PROMO")
    svc.resolve("promo")
    svc.delete("Promo ")
    if not gone(svc, "promo") or not gone(svc, "PROMO"):
        fails.append("deleted link still resolves")
    svc.shorten("https://b.example/y", code="promo")
    if svc.resolve("Promo") != "https://b.example/y":
        fails.append("re-created code does not resolve to its new target")
step("delete after resolve", delete_cached)

def delete_uncached():
    svc = LinkService()
    code = svc.shorten("https://c.example/z")
    svc.delete(code.upper())
    if not gone(svc, code):
        fails.append("deleting a never-resolved link left it resolvable")
    try:
        svc.delete(code)
        fails.append("deleting an already-deleted code should raise KeyError")
    except KeyError:
        pass
step("delete without resolve", delete_uncached)

def cache_still_used():
    store = CountingStore()
    svc = LinkService(store=store, cache_size=8)
    svc.shorten("https://d.example/hot", code="hot")
    for spelling in ("hot", "HOT", " Hot", "hot", "hOt"):
        svc.resolve(spelling)
    if store.gets != 1:
        fails.append(f"5 resolves of one link hit the store {store.gets} times; the cache is not being used")
    svc.update_target("HOT", "https://d.example/hotter")
    for _ in range(3):
        svc.resolve("hot")
    if store.gets > 2:
        fails.append(f"after one update, 3 resolves should hit the store at most once more (total 2), got {store.gets}")
step("cache effectiveness", cache_still_used)

def eviction():
    svc = LinkService(cache_size=2)
    for i in range(5):
        svc.shorten(f"https://e.example/{i}", code=f"L{i}")
        svc.resolve(f"l{i}")
    svc.update_target("L4", "https://e.example/four")
    svc.delete("l0")
    if svc.resolve("L4") != "https://e.example/four" or not gone(svc, "L0"):
        fails.append("update/delete wrong with a small cache")
    if svc.resolve("l2") != "https://e.example/2":
        fails.append("evicted link no longer resolves")
step("small cache", eviction)

for f in fails:
    print("FAIL:", f)
sys.exit(1 if fails else 0)
'''


def main():
    env = clean_env(os.getcwd())
    try:
        proc = subprocess.run([sys.executable, "-c", PROBE], cwd=os.getcwd(), env=env,
                              capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        print("FAIL: shortener code did not finish within 20s")
        return 1
    if proc.returncode != 0:
        print((proc.stdout + proc.stderr).strip()[-1500:] or f"FAIL: probe exited {proc.returncode}")
        return 1
    try:
        tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                               cwd=os.getcwd(), env=env, capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        print("FAIL: existing tests timed out")
        return 1
    if tests.returncode != 0:
        print("FAIL: existing tests in tests/ fail:\n" + tests.stderr[-800:])
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
