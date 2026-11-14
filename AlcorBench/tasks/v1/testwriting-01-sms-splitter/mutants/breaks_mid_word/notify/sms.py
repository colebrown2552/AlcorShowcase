"""Split notification texts into SMS-sized parts."""


def split_sms(text, limit=160):
    """Split ``text`` into parts of at most ``limit`` characters.

    Rules:

    * Leading and trailing whitespace is removed and every run of
      whitespace (spaces, tabs, newlines) becomes a single space.
    * If nothing is left, the result is an empty list.
    * A text that fits within ``limit`` is returned as a single part, as is,
      with no counter.
    * Otherwise every part ends with a counter `` (i/n)`` (part i of n), and
      each part *including* its counter is at most ``limit`` characters.
    * Parts are broken at the last space that fits; that space is dropped.
      A word too long to fit in a part on its own is split at the limit.
    * ValueError if ``limit`` is less than 20.
    """
    if limit < 20:
        raise ValueError("limit must be at least 20")
    text = " ".join(text.split())
    if not text:
        return []
    if len(text) <= limit:
        return [text]
    digits = 1
    while True:
        # " (i/n)" takes 4 characters plus the digits of i and n.
        chunks = _wrap(text, limit - (4 + 2 * digits))
        if len(str(len(chunks))) <= digits:
            break
        digits += 1
    total = len(chunks)
    return [f"{chunk} ({i}/{total})" for i, chunk in enumerate(chunks, start=1)]


def _wrap(text, width):
    chunks = []
    while len(text) > width:
        cut = 0
        if cut <= 0:
            chunks.append(text[:width])
            text = text[width:].lstrip()
        else:
            chunks.append(text[:cut])
            text = text[cut + 1:]
    if text:
        chunks.append(text)
    return chunks
