"""Short-code helpers. Codes are case-insensitive and stored lower-case."""
import string

ALPHABET = string.digits + string.ascii_lowercase
ALLOWED = set(ALPHABET + "-_")


def normalize(code):
    """Canonical form of a user-supplied code."""
    return code.strip().lower()


def validate(code):
    if not code or len(code) > 40 or not set(code) <= ALLOWED:
        raise ValueError(f"invalid short code: {code!r}")
    return code


def encode(number):
    """Base-36 encode a positive integer (used for generated codes)."""
    if number <= 0:
        raise ValueError("number must be positive")
    out = []
    while number:
        number, rem = divmod(number, 36)
        out.append(ALPHABET[rem])
    return "".join(reversed(out))
