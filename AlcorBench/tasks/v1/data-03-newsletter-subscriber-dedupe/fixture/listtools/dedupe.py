"""Remove duplicate subscribers before the list is imported into the mailer."""


def dedupe(rows):
    """Return one row per subscriber.

    `rows` are dicts with the keys email, name, signed_up, source.
    """
    seen = {}
    for row in rows:
        key = row["email"]
        if key not in seen:
            seen[key] = row
    return list(seen.values())
