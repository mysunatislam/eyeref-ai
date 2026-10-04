"""Multi-meridian estimation of (M, J0, J45).

Each eccentric photorefraction measurement probes the refractive power along
one meridian theta_i (the direction of the light source relative to the camera
aperture, expressed in the eye's TABO frame).  The forward model is linear::

    P_i = M + J0 cos(2 theta_i) + J45 sin(2 theta_i) + noise_i,   noise_i ~ N(0, s_i^2)

We solve it as a Gaussian linear model with a weak population prior::

    (M, J0, J45) ~ N(mu0, diag(s_M^2, s_J^2, s_J^2))

Posterior covariance  S = (S0^-1 + A^T W A)^-1
Posterior mean        m = S (S0^-1 mu0 + A^T W P)

The prior makes the problem well posed for 1 or 2 meridians: with a single
meridian, J0/J45 simply stay at their prior (and widen the M uncertainty
accordingly), which is exactly the honest answer.  With >= 3 distinct meridians
the data dominate.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from .power_vector import (
    PowerVector,
    SphCylAxis,
    circular_axis_error,
    from_power_vector,
    normalize_axis,
)

#: Population priors (dioptres).  J components in adults have SD ~0.25-0.35 D.
PRIOR_MEAN = np.array([0.0, 0.0, 0.0])
PRIOR_SD_M = 4.0
PRIOR_SD_J = 0.35


@dataclass
class MeridionalObservation:
    meridian_deg: float
    power_d: float
    sigma_d: float


@dataclass
class PowerVectorPosterior:
    mean: np.ndarray  # (3,) M, J0, J45
    cov: np.ndarray  # (3, 3)
    n_meridians: int
    distinct_meridians: int

    @property
    def power_vector(self) -> PowerVector:
        return PowerVector(float(self.mean[0]), float(self.mean[1]), float(self.mean[2]))

    @property
    def sd(self) -> np.ndarray:
        return np.sqrt(np.diag(self.cov))


def design_row(theta_deg: float) -> np.ndarray:
    t = np.radians(2.0 * theta_deg)
    return np.array([1.0, np.cos(t), np.sin(t)])


def count_distinct_meridians(thetas: Sequence[float], tol_deg: float = 15.0) -> int:
    reps: list[float] = []
    for t in thetas:
        if all(circular_axis_error(t, r) > tol_deg for r in reps):
            reps.append(normalize_axis(t))
    return len(reps)


def fit_power_vector(
    observations: Sequence[MeridionalObservation],
    prior_mean: np.ndarray = PRIOR_MEAN,
    prior_sd_m: float = PRIOR_SD_M,
    prior_sd_j: float = PRIOR_SD_J,
) -> PowerVectorPosterior:
    prior_cov = np.diag([prior_sd_m**2, prior_sd_j**2, prior_sd_j**2])
    prior_prec = np.linalg.inv(prior_cov)
    if not observations:
        return PowerVectorPosterior(prior_mean.copy(), prior_cov, 0, 0)
    A = np.vstack([design_row(o.meridian_deg) for o in observations])
    P = np.array([o.power_d for o in observations])
    w = np.array([1.0 / max(o.sigma_d, 1e-3) ** 2 for o in observations])
    AtW = A.T * w
    post_prec = prior_prec + AtW @ A
    cov = np.linalg.inv(post_prec)
    mean = cov @ (prior_prec @ prior_mean + AtW @ P)
    return PowerVectorPosterior(
        mean=mean,
        cov=cov,
        n_meridians=len(observations),
        distinct_meridians=count_distinct_meridians([o.meridian_deg for o in observations]),
    )


@dataclass
class RefractionDistribution:
    """Monte-Carlo summary of SPH/CYL/AXIS implied by a power-vector posterior."""

    point: SphCylAxis
    sph_ci95: tuple[float, float]
    cyl_ci95: tuple[float, float]
    se_ci95: tuple[float, float]
    axis_sd_deg: float  # circular SD of axis (doubled-angle statistics)
    axis_ci95_halfwidth_deg: float
    p_cyl_ge: dict[float, float] = field(default_factory=dict)
    sph_samples: np.ndarray | None = None
    cyl_samples: np.ndarray | None = None
    axis_samples: np.ndarray | None = None


def sample_refraction(
    posterior: PowerVectorPosterior,
    n: int = 4000,
    seed: int = 7,
    cyl_thresholds: Sequence[float] = (0.5, 0.75, 1.0, 1.5),
    keep_samples: bool = False,
) -> RefractionDistribution:
    rng = np.random.default_rng(seed)
    s = rng.multivariate_normal(posterior.mean, posterior.cov, size=n)
    M, J0, J45 = s[:, 0], s[:, 1], s[:, 2]
    j = np.hypot(J0, J45)
    cyl = -2.0 * j
    sph = M + j
    two_a = np.arctan2(J45, J0)
    axis = np.degrees(two_a / 2.0) % 180.0
    # circular statistics on doubled angle
    R = float(np.hypot(np.mean(np.cos(two_a)), np.mean(np.sin(two_a))))
    R = min(max(R, 1e-12), 1.0)
    circ_sd_doubled = float(np.degrees(np.sqrt(-2.0 * np.log(R))))
    axis_sd = circ_sd_doubled / 2.0
    point_rx = from_power_vector(posterior.power_vector)
    ref_axis = point_rx.axis if point_rx.axis is not None else 0.0
    axis_err = np.array([circular_axis_error(a, ref_axis) for a in axis[:2000]])
    return RefractionDistribution(
        point=point_rx,
        sph_ci95=(float(np.percentile(sph, 2.5)), float(np.percentile(sph, 97.5))),
        cyl_ci95=(float(np.percentile(cyl, 2.5)), float(np.percentile(cyl, 97.5))),
        se_ci95=(float(np.percentile(M, 2.5)), float(np.percentile(M, 97.5))),
        axis_sd_deg=axis_sd,
        axis_ci95_halfwidth_deg=float(np.percentile(axis_err, 95)),
        p_cyl_ge={t: float(np.mean(j * 2.0 >= t)) for t in cyl_thresholds},
        sph_samples=sph if keep_samples else None,
        cyl_samples=cyl if keep_samples else None,
        axis_samples=axis if keep_samples else None,
    )
