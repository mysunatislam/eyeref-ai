"""Focusing on the light.

The person looks at the phone's light about a metre away, and an eye that can
bring it into focus does so: it reads more myopic than it is, by however much
it focused.  This module works out what a capture says about each eye's own
(relaxed) refraction once that is allowed for.  Twin of
apps/web/src/lib/inference/focus.ts; see that file for the model, which this
one follows step for step.

The model, for both eyes at once, since the eyes focus together::

    light    F = -1/d               the refraction whose far point is the light
    demand   D_e = M_e - F          what eye e must focus to see the light
    drive    D* = the smallest demand that is not below 0, or 0 when neither is
    focus    A = min(amplitude(age), g * D*), g uniform over `focus_response`
    reading  r_e ~ N(M_e - A, s_e^2), or with no crescent, inside the dead zone

The posterior is computed on a grid over (M_OD, M_OS), averaged over g.  What
the capture shows about a measured eye uses no prior on it (an eye with no
reading follows its fellow through the correlation between eyes); the class
probabilities use the population's prior on each eye, independent when both
eyes are measured.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal, Optional

import numpy as np

from ..optics.classification import ACCOMMODATION_AMPLITUDE_D, ClassProbabilities, ScreeningThresholds

GRID_LIMIT_D = 30.0
TABLE_STEP_D = 0.01  # the likelihood is tabulated this finely and read back by linear interpolation


@dataclass(frozen=True)
class EyeReading:
    """What one eye's frames measured: a power with its SD, a dead-zone interval, or nothing."""

    kind: Literal["reading", "interval", "none"]
    mean_d: float = 0.0
    sd_d: float = 0.0
    lo_d: float = 0.0
    hi_d: float = 0.0


NO_READING = EyeReading("none")


@dataclass(frozen=True)
class FocusConfig:
    focus_response: tuple[float, float] = (0.0, 1.0)
    response_nodes: int = 11
    grid_step_d: float = 0.05
    prior_mean_d: float = -0.5
    prior_sd_d: float = 2.0
    eye_correlation: float = 0.95
    focusing_d: float = 0.25


@dataclass
class EyeFocus:
    median_d: float
    ci95: tuple[float, float]
    class_probabilities: ClassProbabilities


@dataclass
class FocusPosterior:
    light_d: float
    amplitude_d: float
    focus_response: tuple[float, float]
    p_focusing: float
    mean_focus_d: float
    eyes: dict[str, Optional[EyeFocus]] = field(default_factory=dict)


def _normal_cdf(x: np.ndarray) -> np.ndarray:
    from scipy.special import ndtr

    return ndtr(x)


def _likelihood(r: EyeReading, y: np.ndarray) -> np.ndarray:
    if r.kind == "reading":
        return np.exp(-((r.mean_d - y) ** 2) / (2 * r.sd_d * r.sd_d))
    return _normal_cdf((r.hi_d - y) / r.sd_d) - _normal_cdf((r.lo_d - y) / r.sd_d)


def _tabulate(r: EyeReading, y0: float, y1: float):
    m = math.ceil((y1 - y0) / TABLE_STEP_D) + 1
    ys = y0 + np.arange(m) * TABLE_STEP_D
    v = _likelihood(r, ys)
    return lambda y: np.interp(y, ys, v)  # held flat past the ends, as the twin does


def _span(r: EyeReading, amplitude: float) -> Optional[tuple[float, float]]:
    if r.kind == "reading":
        return r.mean_d - 6 * r.sd_d, r.mean_d + amplitude + 6 * r.sd_d
    if r.kind == "interval":
        return r.lo_d - 6 * r.sd_d, r.hi_d + amplitude + 6 * r.sd_d
    return None


def _summarise(xs: np.ndarray, p: np.ndarray, h: float):
    """Summaries of a grid marginal, each cell's mass spread evenly across it."""
    total = float(p.sum())
    a = xs - h / 2

    def below(x: float) -> float:
        frac = np.clip((x - a) / h, 0.0, 1.0)
        return float((p * frac).sum() / total)

    def quantile(q: float) -> float:
        target = q * total
        c = np.concatenate([[0.0], np.cumsum(p)])
        for i in range(xs.size):
            if c[i] + p[i] >= target and p[i] > 0:
                return float(xs[i] - h / 2 + h * (target - c[i]) / p[i])
        return float(xs[-1] + h / 2)

    return below, quantile


def focus_posterior(
    readings: dict[str, EyeReading],
    age_group: str,
    working_distance_m: float,
    t: ScreeningThresholds,
    cfg: FocusConfig = FocusConfig(),
) -> Optional[FocusPosterior]:
    """What a capture says about each eye's own refraction, allowing for focusing on the light."""
    r_od, r_os = readings.get("OD", NO_READING), readings.get("OS", NO_READING)
    m_od, m_os = r_od.kind != "none", r_os.kind != "none"
    if not m_od and not m_os:
        return None
    amplitude = ACCOMMODATION_AMPLITUDE_D.get(age_group, ACCOMMODATION_AMPLITUDE_D["unknown"])
    F = -1.0 / working_distance_m
    mu, sd, rho, h = cfg.prior_mean_d, cfg.prior_sd_d, cfg.eye_correlation, cfg.grid_step_d

    # one grid for both eyes, wide enough for each reading plus all the focusing it could hide
    spans = [s for s in (_span(r_od, amplitude), _span(r_os, amplitude)) if s is not None]
    if not (m_od and m_os):
        spans.append((mu - 4 * sd, mu + 4 * sd))
    lo = max(-GRID_LIMIT_D, min(s[0] for s in spans))
    hi = min(GRID_LIMIT_D, max(s[1] for s in spans))
    i0 = math.floor(lo / h)
    n = math.ceil(hi / h) - i0 + 1
    xs = (i0 + np.arange(n)) * h

    K = cfg.response_nodes
    g0, g1 = cfg.focus_response
    gs = g0 + (np.arange(K) + 0.5) * (g1 - g0) / K
    # focusing lowers a reading by up to the amplitude, so the likelihoods are read down to that far below
    f_od = _tabulate(r_od, xs[0] - amplitude, xs[-1]) if m_od else (lambda y: np.ones_like(y))
    f_os = _tabulate(r_os, xs[0] - amplitude, xs[-1]) if m_os else (lambda y: np.ones_like(y))

    X = xs[:, None]  # OD along rows
    Y = xs[None, :]  # OS along columns
    d_od, d_os = X - F, Y - F
    drive = np.where(
        d_od >= 0,
        np.where(d_os >= 0, np.minimum(d_od, d_os), d_od),
        np.where(d_os >= 0, d_os, 0.0),
    )
    L = np.zeros((n, n))
    LA = np.zeros((n, n))
    Lf = np.zeros((n, n))
    for g in gs:
        A = np.minimum(amplitude, g * drive)
        lk = f_od(X - A) * f_os(Y - A)
        L += lk
        LA += lk * A
        Lf += np.where(A >= cfg.focusing_d, lk, 0.0)
    L /= K
    LA /= K
    Lf /= K

    marginal = np.exp(-((xs - mu) ** 2) / (2 * sd * sd))
    cond_var2 = 2 * sd * sd * (1 - rho * rho)
    both = m_od and m_os
    if both:
        follow = np.ones((n, n))
        w = marginal[:, None] * marginal[None, :]
    elif m_od:
        follow = np.exp(-((Y - (mu + rho * (X - mu))) ** 2) / cond_var2)
        w = marginal[:, None] * follow
    else:
        follow = np.exp(-((X - (mu + rho * (Y - mu))) ** 2) / cond_var2)
        w = marginal[None, :] * follow
    joint = L * w
    z = float(joint.sum())
    pop_od, pop_os = joint.sum(axis=1), joint.sum(axis=0)
    seen = L * follow
    seen_od, seen_os = seen.sum(axis=1), seen.sum(axis=0)
    focusing = float((Lf * w).sum())
    focus_sum = float((LA * w).sum())

    def eye(measured: bool, s: np.ndarray, p: np.ndarray) -> Optional[EyeFocus]:
        if not measured:
            return None
        _, q = _summarise(xs, s, h)
        below, _ = _summarise(xs, p, h)
        my = below(t.myopia_se)
        hy = 1 - below(t.hyperopia_se)
        return EyeFocus(
            median_d=q(0.5),
            ci95=(q(0.025), q(0.975)),
            class_probabilities=ClassProbabilities(my, max(0.0, 1 - my - hy), hy),
        )

    return FocusPosterior(
        light_d=F,
        amplitude_d=amplitude,
        focus_response=(g0, g1),
        p_focusing=focusing / z if z > 0 else 0.0,
        mean_focus_d=focus_sum / z if z > 0 else 0.0,
        eyes={"OD": eye(m_od, seen_od, pop_od), "OS": eye(m_os, seen_os, pop_os)},
    )
