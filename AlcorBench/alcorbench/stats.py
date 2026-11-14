"""Statistics for pass/fail trials.

The unit of analysis is the task, not the trial: trials of one task are not
independent draws from the task population, so every interval resamples
tasks. A task's score is its pass fraction over its trials. Trials that ended
in an infrastructure error were never attempted and are left out everywhere.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from fractions import Fraction
from statistics import fmean

Z95 = 1.959963984540054  # two-sided 95% normal quantile


def per_task(rows: list[dict]) -> dict[str, dict[int, bool]]:
    """Graded outcomes per task id, keyed by trial number; infra errors are dropped."""
    out: dict[str, dict[int, bool]] = {}
    for r in rows:
        if not r.get("infra_error"):
            out.setdefault(r["task_id"], {})[int(r["trial"])] = bool(r["passed"])
    return {t: dict(sorted(v.items())) for t, v in out.items()}


def pass_fractions(outcomes: dict[str, dict[int, bool]]) -> dict[str, float]:
    return {t: sum(v.values()) / len(v) for t, v in outcomes.items() if v}


def pass_rate_lower_bound(rows: list[dict], task_ids: set[str], trials: int) -> float:
    """Mean pass fraction if every infra-failed or missing trial had failed.

    An incomplete run reports this beside its pass rate, so dropping trials
    can never make it look better than it is.
    """
    outcomes = per_task(rows)
    return fmean(sum(outcomes.get(t, {}).values()) / trials for t in sorted(task_ids))


def complete_tasks(rows: list[dict], trials: int) -> set[str]:
    """Tasks graded on every one of `trials` trials (no missing or infra-failed trial)."""
    return {t for t, v in per_task(rows).items() if len(v) == trials}


def bootstrap_mean_ci(
    values: list[float], seed: int = 0, n_resamples: int = 10_000, level: float = 0.95
) -> tuple[float, float]:
    """Percentile bootstrap CI of the mean, resampling the given values (tasks)."""
    if not values:
        raise ValueError("no values")
    rng = random.Random(seed)
    n = len(values)
    means = sorted(fmean(rng.choices(values, k=n)) for _ in range(n_resamples))
    tail = (1 - level) / 2
    lo = means[int(math.floor(tail * n_resamples))]
    hi = means[int(math.ceil((1 - tail) * n_resamples)) - 1]
    return lo, hi


def wilson_interval(successes: int, n: int, z: float = Z95) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion; sane at 0 and n successes."""
    if n == 0:
        return 0.0, 1.0
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def sign_test(wins: int, losses: int) -> float:
    """Exact two-sided sign test p-value; ties are dropped before calling."""
    n = wins + losses
    if n == 0:
        return 1.0
    k = min(wins, losses)
    tail = Fraction(sum(math.comb(n, i) for i in range(k + 1)), 2**n)
    return float(min(Fraction(1), 2 * tail))


def flip_rate(outcomes: dict[str, dict[int, bool]]) -> float | None:
    """Share of tasks with 2+ graded trials whose trials disagree; None if none repeat."""
    repeated = [list(v.values()) for v in outcomes.values() if len(v) >= 2]
    if not repeated:
        return None
    return sum(1 for v in repeated if any(v) and not all(v)) / len(repeated)


@dataclass
class Summary:
    n_tasks: int
    n_trials: int
    mean_pass: float
    ci: tuple[float, float]
    first_try_passes: int
    first_try_tasks: int  # tasks whose trial 0 was graded
    first_try_ci: tuple[float, float]
    flip_rate: float | None


def summarize(rows: list[dict], seed: int = 0) -> Summary:
    """Mean per-task pass fraction with a task bootstrap CI, first-try Wilson, flips."""
    outcomes = per_task(rows)
    # Sorted by task id so the bootstrap sees the same sequence whatever the row order.
    fracs = [f for _, f in sorted(pass_fractions(outcomes).items())]
    first_tries = [v[0] for v in outcomes.values() if 0 in v]
    return Summary(
        n_tasks=len(outcomes),
        n_trials=sum(len(v) for v in outcomes.values()),
        mean_pass=fmean(fracs),
        ci=bootstrap_mean_ci(fracs, seed=seed),
        first_try_passes=sum(first_tries),
        first_try_tasks=len(first_tries),
        first_try_ci=wilson_interval(sum(first_tries), len(first_tries)),
        flip_rate=flip_rate(outcomes),
    )


@dataclass
class Paired:
    tasks: list[str]
    mean_a: float
    mean_b: float
    mean_diff: float  # a - b
    ci: tuple[float, float]
    wins: int  # tasks where a has the higher pass fraction
    losses: int
    ties: int
    p_sign: float
    diffs: dict[str, float]


def paired_compare(rows_a: list[dict], rows_b: list[dict], seed: int = 0) -> Paired:
    """Compare two runs on the tasks both contain, task by task."""
    fa = pass_fractions(per_task(rows_a))
    fb = pass_fractions(per_task(rows_b))
    shared = sorted(set(fa) & set(fb))
    if not shared:
        raise ValueError("the two runs share no tasks")
    diffs = {t: fa[t] - fb[t] for t in shared}
    d = list(diffs.values())
    wins = sum(1 for x in d if x > 0)
    losses = sum(1 for x in d if x < 0)
    return Paired(
        tasks=shared,
        mean_a=fmean(fa[t] for t in shared),
        mean_b=fmean(fb[t] for t in shared),
        mean_diff=fmean(d),
        ci=bootstrap_mean_ci(d, seed=seed),
        wins=wins,
        losses=losses,
        ties=len(d) - wins - losses,
        p_sign=sign_test(wins, losses),
        diffs=diffs,
    )
