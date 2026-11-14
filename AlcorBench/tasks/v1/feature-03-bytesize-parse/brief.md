The quota settings page lets admins type sizes like `500 MB` or `1.5 GiB`, and right now each form parses them its own way. We already have `format_size` in `sizes/units.py`; please add the inverse next to it and export it from the `sizes` package.

**Signature:** `parse_size(text: str) -> int`, the number of bytes.

**Accepted input:** optional surrounding whitespace, a non-negative number, optional whitespace, then an optional unit.

- The number is digits with at most one decimal point (`12`, `0.5`, `.5`, `2.25`). No sign, no exponent, no thousands separators.
- Units are the ones in `DECIMAL_UNITS` and `BINARY_UNITS`: `B`, `kB`, `MB`, `GB`, `TB` (powers of 1000) and `KiB`, `MiB`, `GiB`, `TiB` (powers of 1024). Matching is case-insensitive, so `kb`, `KB` and `kB` all mean 1000 and `gib` means 2**30.
- No unit means bytes.

**Result:** number x unit factor, rounded **down** to a whole byte. It must be exact for any decimal input: `"0.3 GB"` is `300000000` and `"1.1 TB"` is `1100000000000`, so don't go through binary floats.

**Errors:** raise `ValueError` for anything else: empty or blank text, a negative number, an unknown unit (`"5 XB"`, `"5 bytes"`), or junk (`"1.2.3 MB"`, `"MB"`).

Examples: `parse_size("1.5 GiB") == 1610612736`, `parse_size("  42 ") == 42`, `parse_size("2kb") == 2000`.

The tests in `tests/test_sizes.py` must keep passing; don't change them.
