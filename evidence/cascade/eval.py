#!/usr/bin/env python3
"""Recompute the v1..v4 think=false table from data/replays.json (offline)."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def score(rows):
    # arithmetic copied from alcor_calibrate.score; error rows have no alcor verdict and are excluded
    ok = [r for r in rows if r["alcor"] and not r.get("error")]
    f = [r for r in ok if r["opus"] == "fail"]
    p = [r for r in ok if r["opus"] == "pass"]
    fail_rows = [r for r in ok if r["alcor"] == "fail"]
    return {"catch_rate_on_opus_fail": round(sum(r["alcor"] == "fail" for r in f) / max(1, len(f)), 2),
            "false_alarm_on_opus_pass": round(sum(r["alcor"] == "fail" for r in p) / max(1, len(p)), 2),
            "precision_of_alcor_fail": round(sum(r["opus"] == "fail" for r in fail_rows) / max(1, len(fail_rows)), 2)}


def main():
    data = json.loads((HERE / "data" / "replays.json").read_text())
    for v in data["versions"]:
        s = score([r for r in v["rows"] if r["think"] is False])
        print(f"{v['version']} catch {s['catch_rate_on_opus_fail']:.2f} false_alarm {s['false_alarm_on_opus_pass']:.2f} precision {s['precision_of_alcor_fail']:.2f}")


if __name__ == "__main__":
    main()
