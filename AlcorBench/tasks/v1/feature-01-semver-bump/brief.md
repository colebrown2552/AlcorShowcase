Our release script still bumps versions by string-splitting, and it gets pre-releases wrong. Please add a `bump` method to `Version` in `semverlite/version.py` so the script can do `parse(current).bump("minor")`.

**Signature:** `Version.bump(part: str) -> Version`, where `part` is `"major"`, `"minor"` or `"patch"`. It returns a new `Version`; the original is unchanged (the dataclass is frozen). The result never carries pre-release or build metadata.

**Rules** (these follow what npm does):

- `"patch"`: if the version has a pre-release tag, the result is the same major.minor.patch without the tag (`1.2.3-rc.1` -> `1.2.3`). Otherwise patch + 1 (`1.2.3` -> `1.2.4`).
- `"minor"`: if the version has a pre-release tag **and** patch is 0, the result drops the tag (`1.3.0-beta` -> `1.3.0`). Otherwise minor + 1 and patch reset to 0 (`1.2.3` -> `1.3.0`, `1.2.3-rc.1` -> `1.3.0`).
- `"major"`: if the version has a pre-release tag **and** minor and patch are both 0, the result drops the tag (`2.0.0-rc.1` -> `2.0.0`). Otherwise major + 1, minor and patch reset to 0.
- Build metadata (`+...`) is always dropped.
- Any other `part` raises `ValueError`.

The existing tests in `tests/test_version.py` must keep passing (`python3 -m unittest discover -s tests`); don't change them. Done means the method exists with exactly this behaviour and nothing else in the module's behaviour changes.
