"""Parse ingredient lines such as "1 1/2 cup flour" or "3 eggs"."""
from fractions import Fraction


def parse_quantity(text):
    """'2', '1/2', '1 1/2', '0.75' -> Fraction."""
    total = Fraction(0)
    for part in text.split():
        total += Fraction(part)
    return total


def parse_line(line):
    """Return (quantity: Fraction, unit: str, name: str).

    The unit is the second word when it is a known unit, otherwise ''.
    """
    words = line.split()
    qty_words = []
    while words and all(ch.isdigit() or ch in "/." for ch in words[0]):
        qty_words.append(words.pop(0))
    if not qty_words:
        raise ValueError(f"no quantity in {line!r}")
    unit = ""
    if words and words[0].lower() in UNITS:
        unit = words.pop(0).lower()
    return parse_quantity(" ".join(qty_words)), unit, " ".join(words)


UNITS = {"cup", "cups", "tbsp", "tsp", "g", "kg", "ml", "l", "pinch", "clove", "cloves"}
