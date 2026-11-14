"""Money helpers. All amounts are handled as integer cents."""


def parse_amount(text):
    """Parse a price string into integer cents.

    Accepts an optional leading ``$``, thousands separators (``1,234.50``),
    a leading minus sign or accounting-style parentheses for negative
    amounts (``-2.30`` or ``(2.30)``). Raises ValueError for anything else.
    """
    cleaned = text.strip().replace("$", "").replace(",", "")
    negative = False
    if cleaned.startswith("(") and cleaned.endswith(")"):
        negative = True
        cleaned = cleaned[1:-1].strip()
    if cleaned.startswith("-"):
        negative = not negative
        cleaned = cleaned[1:]
    if not cleaned or not cleaned[0].isdigit():
        raise ValueError(f"not an amount: {text!r}")
    cents = round(float(cleaned) * 100)
    return -cents if negative else cents


def format_cents(cents):
    """Format integer cents as ``1,234.50`` (``-1,234.50`` when negative)."""
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), 100)
    return f"{sign}{whole:,}.{frac:02d}"
