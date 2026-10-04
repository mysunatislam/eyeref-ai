"""Screening classification from a Gaussian posterior on spherical equivalent.

Thresholds are configurable because definitions differ between adults and
children (e.g. paediatric hyperopia is commonly flagged at >= +2.00 D) and
between screening programmes.  Probabilities are model-based, not yet
empirically calibrated (see docs/MODEL_TRAINING.md - conformal calibration).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

AgeGroup = Literal["child_3_7", "child_8_12", "teen", "adult_18_39", "adult_40_59", "adult_60_plus", "unknown"]
RefractiveClass = Literal["myopia", "emmetropia", "hyperopia"]


@dataclass(frozen=True)
class ScreeningThresholds:
    myopia_se: float = -0.50
    hyperopia_se: float = 0.50
    astigmatism_cyl: float = 0.75
    anisometropia_se: float = 1.00
    high_myopia_se: float = -6.00
    high_hyperopia_se: float = 5.00


def thresholds_for_age(age: AgeGroup) -> ScreeningThresholds:
    if age in ("child_3_7",):
        return ScreeningThresholds(myopia_se=-0.75, hyperopia_se=2.00, astigmatism_cyl=1.50)
    if age in ("child_8_12",):
        return ScreeningThresholds(myopia_se=-0.50, hyperopia_se=1.50, astigmatism_cyl=1.00)
    return ScreeningThresholds()


#: Residual accommodation uncertainty (SD, D) by age group.  Non-cycloplegic
#: measurements in young eyes are biased towards myopia and fluctuate; this is
#: an explicit, documented model of that limitation (docs/MEDICAL_LIMITATIONS.md).
ACCOMMODATION_SD: dict[str, float] = {
    "child_3_7": 0.80,
    "child_8_12": 0.65,
    "teen": 0.50,
    "adult_18_39": 0.35,
    "adult_40_59": 0.20,
    "adult_60_plus": 0.10,
    "unknown": 0.50,
}


def normal_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


@dataclass
class ClassProbabilities:
    myopia: float
    emmetropia: float
    hyperopia: float

    @property
    def label(self) -> RefractiveClass:
        d = {"myopia": self.myopia, "emmetropia": self.emmetropia, "hyperopia": self.hyperopia}
        return max(d, key=d.get)  # type: ignore[arg-type,return-value]

    @property
    def confidence(self) -> float:
        return max(self.myopia, self.emmetropia, self.hyperopia)


def class_probabilities(mu_se: float, sd_se: float, t: ScreeningThresholds) -> ClassProbabilities:
    sd = max(sd_se, 1e-6)
    p_my = normal_cdf((t.myopia_se - mu_se) / sd)
    p_hy = 1.0 - normal_cdf((t.hyperopia_se - mu_se) / sd)
    return ClassProbabilities(p_my, max(0.0, 1.0 - p_my - p_hy), p_hy)


def severity_label(se: float, t: ScreeningThresholds) -> str:
    if se <= t.high_myopia_se:
        return "High myopia"
    if se <= -3.0:
        return "Moderate myopia"
    if se <= t.myopia_se:
        return "Mild myopia"
    if se >= t.high_hyperopia_se:
        return "High hyperopia"
    if se >= 2.0:
        return "Moderate hyperopia"
    if se >= t.hyperopia_se:
        return "Mild hyperopia"
    return "No significant spherical error"


def anisometropia_probability(mu_a: float, sd_a: float, mu_b: float, sd_b: float, threshold: float) -> float:
    """P(|SE_a - SE_b| >= threshold) for independent Gaussian posteriors."""
    mu = mu_a - mu_b
    sd = math.sqrt(sd_a**2 + sd_b**2)
    return float(1.0 - (normal_cdf((threshold - mu) / sd) - normal_cdf((-threshold - mu) / sd)))


def truncated_prior_class_probabilities(
    lo: float, hi: float, t: ScreeningThresholds, prior_mean: float, prior_sd: float
) -> ClassProbabilities:
    """Class probabilities when only an interval [lo, hi] is known (dead zone).

    The population prior N(prior_mean, prior_sd) is truncated to the interval;
    the result therefore depends on the screening population and is reported
    as such in docs/PHOTOREFRACTION.md.
    """
    def mass(a: float, b: float) -> float:
        a, b = max(a, lo), min(b, hi)
        if b <= a:
            return 0.0
        return normal_cdf((b - prior_mean) / prior_sd) - normal_cdf((a - prior_mean) / prior_sd)

    total = mass(lo, hi)
    if total <= 0:
        return ClassProbabilities(1 / 3, 1 / 3, 1 / 3)
    return ClassProbabilities(
        mass(-math.inf, t.myopia_se) / total,
        mass(t.myopia_se, t.hyperopia_se) / total,
        mass(t.hyperopia_se, math.inf) / total,
    )
