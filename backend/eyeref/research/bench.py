"""Bench-test analysis (Stage 0 / Stage 1 of docs/VALIDATION_PROTOCOL.md).

Input: per-frame features recorded with a model eye (or subjects wearing
trial lenses) at known induced refraction values.  The questions answered are
exactly the go/no-go questions of the bench experiment:

1. Does each feature change *monotonically* with refraction?  (Spearman rho)
2. Is it *reproducible*?  (within-lens SD, ICC(1,1) across repeated captures)
3. Where is the *dead zone* empirically, and does it match e/(d p)?
4. Does crescent side flip sign at the far-point-equals-camera point?
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from scipy import stats


@dataclass
class FeatureBenchResult:
    feature: str
    spearman_rho: float
    spearman_p: float
    monotonic_fraction: float  # fraction of adjacent lens steps moving in the dominant direction
    within_level_sd: float
    icc_1_1: float
    level_means: dict[float, float]


def icc_1_1(groups: Sequence[Sequence[float]]) -> float:
    """One-way random-effects ICC(1,1) for repeated measurements per level."""
    g = [np.asarray(x, float) for x in groups if len(x) >= 2]
    if len(g) < 2:
        return float("nan")
    k = np.mean([len(x) for x in g])
    grand = np.mean(np.concatenate(g))
    msb = sum(len(x) * (x.mean() - grand) ** 2 for x in g) / (len(g) - 1)
    msw = sum(((x - x.mean()) ** 2).sum() for x in g) / (sum(len(x) for x in g) - len(g))
    return float((msb - msw) / (msb + (k - 1) * msw)) if (msb + (k - 1) * msw) > 0 else float("nan")


def analyse_feature(levels_d: Sequence[float], values: Sequence[float], name: str) -> FeatureBenchResult:
    lv = np.asarray(levels_d, float)
    v = np.asarray(values, float)
    ok = np.isfinite(v)
    lv, v = lv[ok], v[ok]
    rho, p = stats.spearmanr(lv, v)
    uniq = np.unique(lv)
    means = {float(u): float(v[lv == u].mean()) for u in uniq}
    m = np.array([means[float(u)] for u in uniq])
    steps = np.sign(np.diff(m))
    dom = np.sign(steps.sum()) or 1.0
    mono = float(np.mean(steps == dom)) if steps.size else float("nan")
    within = float(np.sqrt(np.mean([v[lv == u].var(ddof=1) for u in uniq if (lv == u).sum() > 1]))) if uniq.size else float("nan")
    return FeatureBenchResult(name, float(rho), float(p), mono, within, icc_1_1([v[lv == u] for u in uniq]), means)


def empirical_dead_zone(levels_d: Sequence[float], crescent_present: Sequence[bool]) -> tuple[float, float] | None:
    """Range of lens levels where the crescent was absent in >50% of frames."""
    lv = np.asarray(levels_d, float)
    cp = np.asarray(crescent_present, bool)
    absent = [float(u) for u in np.unique(lv) if (~cp[lv == u]).mean() > 0.5]
    return (min(absent), max(absent)) if absent else None
