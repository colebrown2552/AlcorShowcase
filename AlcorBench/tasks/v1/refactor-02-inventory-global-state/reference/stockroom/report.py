"""Human-readable stock reports."""


def low_stock_report(inventory, threshold=5):
    """Lines for every SKU at or below ``threshold``, lowest first."""
    levels = inventory.all_levels()
    low = sorted((n, sku) for sku, n in levels.items() if n <= threshold)
    if not low:
        return f"All {len(levels)} SKUs above {threshold}."
    lines = [f"{len(low)} of {len(levels)} SKUs at or below {threshold}:"]
    lines += [f"  {sku:<12} {n:>5}" for n, sku in low]
    return "\n".join(lines)
