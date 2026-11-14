"""Hidden check: median averages the two middle values of an even-length list."""

import json
import os
import subprocess
import sys

DRIVER = r"""
import json
from numstat.center import median
cases = [[5, 1, 9, 3], [7], [3, 1, 2], [-2, 10], [1.5, 2.5, 0.5, 4.0], [2, 2, 8, 8, 8, 8]]
out = {"values": [median(c) for c in cases]}
data = [4, 3, 2, 1]
median(data)
out["unchanged"] = data == [4, 3, 2, 1]
try:
    median([])
    out["empty"] = "no error"
except ValueError:
    out["empty"] = "ValueError"
print("RESULT", json.dumps(out))
"""
EXPECTED = [4.0, 7, 2, 4.0, 2.0, 8.0]


def main() -> int:
    try:
        # Agent code gets an explicit minimal environment, nothing inherited.
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8"}
        proc = subprocess.run([sys.executable, "-c", DRIVER], capture_output=True,
                              text=True, timeout=20, env=env)
    except subprocess.TimeoutExpired:
        print("median did not return within 20 s")
        return 1
    if proc.returncode != 0:
        print("could not run median:", proc.stderr.strip().splitlines()[-1:] or proc.returncode)
        return 1
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")]
    if not lines:
        print("the code under test printed no result (it may have exited early)")
        return 1
    got = json.loads(lines[-1][len("RESULT "):])
    failures = []
    for case, (want, have) in enumerate(zip(EXPECTED, got["values"])):
        if not isinstance(have, (int, float)) or abs(have - want) > 1e-9:
            failures.append(f"case {case}: expected {want}, got {have}")
    if not got["unchanged"]:
        failures.append("median modified its input list")
    if got["empty"] != "ValueError":
        failures.append("median([]) no longer raises ValueError")
    for line in failures:
        print(line)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
