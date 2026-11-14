"""Remove duplicate subscribers before the list is imported into the mailer."""


def dedupe(rows):
    """Return one row per subscriber.

    `rows` are dicts with the keys email, name, signed_up, source.
    Addresses are compared trimmed and lower-cased; the newest sign-up wins
    (the later row on a tie). Output keeps first-appearance order.
    """
    best = {}
    for row in rows:
        key = (row.get("email") or "").strip().lower()
        if not key:
            continue
        current = best.get(key)
        if current is None or row["signed_up"] >= current["signed_up"]:
            best[key] = dict(row, email=key)
    return list(best.values())
