"""Split-conformal calibration of predictive intervals.

Given calibration residuals r_i = |y_i - mu_i| / sigma_i (normalised by the
model's own predicted SD), the (1-alpha) quantile q gives intervals
mu +/- q * sigma with finite-sample marginal coverage >= 1-alpha under
exchangeability (Vovk; Angelopoulos & Bates 2021).  ``scale = q / 1.96`` is
stored with the exported model so that 95% intervals become calibrated.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np


def conformal_quantile(norm_residuals: Sequence[float], alpha: float = 0.05) -> float:
    r = np.sort(np.abs(np.asarray(norm_residuals, float)))
    n = r.size
    if n == 0:
        return float("inf")
    k = min(n, math.ceil((n + 1) * (1 - alpha)))
    return float(r[k - 1])


def coverage(y: Sequence[float], lo: Sequence[float], hi: Sequence[float]) -> float:
    y, lo, hi = (np.asarray(v, float) for v in (y, lo, hi))
    return float(((y >= lo) & (y <= hi)).mean()) if y.size else float("nan")
