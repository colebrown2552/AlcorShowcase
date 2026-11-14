"""Measures of the centre of a list of numbers."""


def mean(values):
    """Arithmetic mean. Raises ValueError on an empty list."""
    if not values:
        raise ValueError("mean of empty list")
    return sum(values) / len(values)


def median(values):
    """Middle value of the sorted values. Raises ValueError on an empty list."""
    if not values:
        raise ValueError("median of empty list")
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2
