"""Dead-zone brightness-gradient calibration.

Inside the eccentric-photorefraction dead zone no crescent forms, but the
reflex brightness slope along the source meridian still varies with defocus.
Its gain (dioptres per unit normalised slope) depends on the flash size/shape,
camera optics and fundus reflectance and therefore must be measured, e.g. with
a model eye and trial lenses (Stage 1 bench test) or subjects with known
refraction.  This module fits it by robust linear regression.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np


@dataclass
class GradientCalibration:
    gain: float
    intercept: float
    residual_sd: float
    n: int
    r: float


def fit_gradient_gain(gradients: Sequence[float], powers_minus_centre_d: Sequence[float]) -> GradientCalibration:
    """Fit  (power - centre)/half_width = -gain * gradient + b  (Huber-like reweighting).

    ``powers_minus_centre_d`` must already be divided by the dead-zone half-width;
    ``residual_sd_d`` is then in half-width units as well.
    """
    g = np.asarray(gradients, float)
    y = np.asarray(powers_minus_centre_d, float)
    if g.size < 5:
        raise ValueError("need >= 5 calibration frames")
    w = np.ones_like(g)
    coef = np.zeros(2)
    X = np.column_stack([g, np.ones_like(g)])
    for _ in range(10):
        W = np.sqrt(w)
        coef, *_ = np.linalg.lstsq(X * W[:, None], y * W, rcond=None)
        r = y - X @ coef
        s = 1.4826 * np.median(np.abs(r)) + 1e-9
        w = np.clip(1.345 * s / np.maximum(np.abs(r), 1e-9), 0, 1)
    resid = y - X @ coef
    corr = float(np.corrcoef(g, y)[0, 1]) if g.std() > 0 and y.std() > 0 else 0.0
    return GradientCalibration(float(-coef[0]), float(coef[1]), float(resid.std(ddof=2)), int(g.size), corr)
