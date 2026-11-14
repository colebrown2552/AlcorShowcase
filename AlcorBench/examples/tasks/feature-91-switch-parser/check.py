"""Hidden check: parse_flag accepts the six word pairs and rejects everything else."""

import json
import os
import subprocess
import sys

DRIVER = r"""
import json
from settings.flags import flag_from_env, parse_flag
good = [" YES ", "Off", "1", "0\n", "TRUE", "nO", "\toN", "False"]
out = {"good": [parse_flag(v) for v in good], "bad": {}}
out["types"] = [type(parse_flag(v)).__name__ for v in good]
for v in ["2", "enabled", "", "y", "of f", "maybe"]:
    try:
        parse_flag(v)
        out["bad"][v] = "accepted"
    except ValueError as exc:
        out["bad"][v] = "named" if v in str(exc) else "unnamed"
out["env"] = [flag_from_env({"X": " on"}, "X"), flag_from_env({}, "X", True),
              flag_from_env({"X": "  "}, "X")]
print("RESULT", json.dumps(out))
"""


def main() -> int:
    try:
        # Agent code gets an explicit minimal environment, nothing inherited.
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8"}
        proc = subprocess.run([sys.executable, "-c", DRIVER], capture_output=True,
                              text=True, timeout=20, env=env)
    except subprocess.TimeoutExpired:
        print("parse_flag did not return within 20 s")
        return 1
    if proc.returncode != 0:
        print("could not run parse_flag:", proc.stderr.strip().splitlines()[-1:] or proc.returncode)
        return 1
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")]
    if not lines:
        print("the code under test printed no result (it may have exited early)")
        return 1
    got = json.loads(lines[-1][len("RESULT "):])
    failures = []
    if got["good"] != [True, False, True, False, True, False, True, False]:
        failures.append(f"wrong values for accepted words: {got['good']}")
    if set(got["types"]) != {"bool"}:
        failures.append(f"parse_flag must return bool, got {sorted(set(got['types']))}")
    for value, outcome in got["bad"].items():
        if outcome == "accepted":
            failures.append(f"{value!r} was accepted")
        elif outcome == "unnamed" and len(value) >= 4:  # short values match too easily
            failures.append(f"the error for {value!r} does not name the value")
    if got["env"] != [True, True, False]:
        failures.append(f"flag_from_env changed behaviour: {got['env']}")
    for line in failures:
        print(line)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
