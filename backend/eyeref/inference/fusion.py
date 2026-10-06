"""Multi-frame + multi-meridian fusion, uncertainty and output gating.

Error model (all SDs in dioptres) for one meridian with n usable frames::

    var_meridian = median(sigma_frame^2) * (1/n + RHO)   # partly systematic
                 + temporal_sd^2 / n                     # fixation/accommodation jitter

Common-mode terms that shift ALL meridians equally are added to the M variance
*after* the meridional fit (they do not inform astigmatism):

    var_M += accommodation_sd(age)^2 + calibration_sd^2

The eyes focus on the light, which makes an eye that can see it read more
myopic than it is; eyeref.inference.focus works out each eye's own refraction
from both eyes' readings, and the gating below releases a number only when
that is pinned down.  A capture through a stage 1 trial lens turns this off
(`focus_model=False`): there the reading is the eye as the camera saw it.

The Bayesian meridional fit (eyeref.optics.meridional) yields a posterior over
(M, J0, J45); Monte-Carlo sampling converts it to SPH/CYL/AXIS intervals.  The
output is then *gated*: quantitative numbers are only released when their
uncertainty is below explicit thresholds, otherwise a screening category or a
"repeat measurement" result is returned.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Optional

import numpy as np
from pydantic import BaseModel, Field

from .. import __version__
from ..optics.classification import (
    ACCOMMODATION_SD,
    ClassProbabilities,
    ScreeningThresholds,
    anisometropia_probability,
    class_probabilities,
    severity_label,
    thresholds_for_age,
    truncated_prior_class_probabilities,
)
from ..optics.meridional import (
    MeridionalObservation,
    RefractionDistribution,
    count_distinct_meridians,
    fit_power_vector,
    sample_refraction,
)
from ..optics.power_vector import format_diopters, normalize_axis
from ..types import EyeSide, FrameRecord, OutputLevel
from .focus import NO_READING, EyeReading, FocusConfig, FocusPosterior, focus_posterior

RHO_SYSTEMATIC = 0.5
MERIDIAN_BIN_DEG = 22.5
INTERVAL_BOUND_SD = 0.35

MEDICAL_DISCLAIMER = (
    "Experimental research prototype. This is a screening estimate, not an eyeglass prescription, "
    "and it does not replace a comprehensive eye examination. Abnormal red reflexes can indicate "
    "conditions unrelated to refractive error. Sudden vision loss, eye pain, flashes, floaters or "
    "trauma require urgent professional assessment."
)


class GatingConfig(BaseModel):
    min_usable_frames_per_meridian: int = 3
    max_se_ci_halfwidth_quantitative: float = 1.0
    min_class_confidence_screening: float = 0.80
    astigmatism_quantification_enabled: bool = False  # gated until multi-meridian validation
    min_distinct_meridians_for_cyl: int = 3
    max_cyl_ci_width: float = 1.0
    max_axis_sd_deg: float = 15.0
    reflex_asymmetry_ratio: float = 1.35
    calibration_sd_uncalibrated: float = 0.50
    calibration_sd_calibrated: float = 0.20
    population_prior_mean: float = -0.5
    population_prior_sd: float = 2.0
    #: the share of what it needs that an eye focuses on the light, assumed uniform over this range
    focus_response: tuple[float, float] = (0.0, 1.0)
    #: correlation between a person's two eyes in the population (the focusing model's prior)
    eye_correlation: float = 0.95

    def focus_config(self) -> FocusConfig:
        return FocusConfig(
            focus_response=self.focus_response,
            prior_mean_d=self.population_prior_mean,
            prior_sd_d=self.population_prior_sd,
            eye_correlation=self.eye_correlation,
        )


class MeridianSummary(BaseModel):
    meridian_deg: float
    n_frames: int
    n_usable: int
    status: Literal["quantitative", "interval", "insufficient"]
    power_d: Optional[float] = None
    sigma_d: Optional[float] = None
    temporal_sd_d: Optional[float] = None
    interval_d: Optional[tuple[float, float]] = None
    frame_powers: list[float] = Field(default_factory=list)


class EyeResult(BaseModel):
    eye: EyeSide
    output_level: OutputLevel
    message: str
    se_d: Optional[float] = None
    se_ci95: Optional[tuple[float, float]] = None
    sph_d: Optional[float] = None
    sph_ci95: Optional[tuple[float, float]] = None
    cyl_d: Optional[float] = None
    cyl_ci95: Optional[tuple[float, float]] = None
    axis_deg: Optional[float] = None
    axis_uncertainty_deg: Optional[float] = None
    power_vector: Optional[dict[str, float]] = None
    power_vector_sd: Optional[dict[str, float]] = None
    refractive_class: Optional[str] = None
    severity: Optional[str] = None
    class_probabilities: Optional[dict[str, float]] = None
    astigmatism_status: Literal["quantified", "screening_only", "not_assessed"] = "not_assessed"
    astigmatism_probability: Optional[float] = None
    confidence: Optional[float] = None
    quality_grade: Optional[str] = None
    median_quality: Optional[float] = None
    n_frames: int = 0
    n_usable_frames: int = 0
    meridians: list[MeridianSummary] = Field(default_factory=list)
    reflex_mean_luma: Optional[float] = None
    dead_zone_d: Optional[tuple[float, float]] = None
    #: 95% interval for the eye's own refraction after allowing for focusing on the light (D); absent on
    #: records from before the focusing model, and on stage 1 captures
    refraction_range95: Optional[tuple[float, float]] = None
    #: focusing on the light is what kept a number back: it could hide 1 D or more above the reading
    focus_limited: bool = False
    notes: list[str] = Field(default_factory=list)


class Provenance(BaseModel):
    model_name: str
    model_version: str
    estimator_kind: str
    calibration_version: str
    device_profile: str
    extractor_version: str
    app_version: str = __version__
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))


class FocusSummary(BaseModel):
    """What the focusing model assumed and found for a capture."""

    working_distance_m: float
    light_d: float
    amplitude_d: float
    focus_response: tuple[float, float]
    p_focusing: float
    mean_focus_d: float


class AssessmentReport(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    simulated: bool
    eyes: dict[str, EyeResult]
    anisometropia_probability: Optional[float] = None
    se_difference_d: Optional[float] = None
    reflex_asymmetry_ratio: Optional[float] = None
    reflex_asymmetry_flag: bool = False
    referral_reasons: list[str] = Field(default_factory=list)
    interpretation: str = ""
    disclaimer: str = MEDICAL_DISCLAIMER
    provenance: Provenance
    focus: Optional[FocusSummary] = None


def _bin_meridian(m: float) -> float:
    return normalize_axis(round(normalize_axis(m) / MERIDIAN_BIN_DEG) * MERIDIAN_BIN_DEG)


def _robust_sd(x: np.ndarray) -> float:
    if x.size < 2:
        return 0.0
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


@dataclass
class EyeMeasurement:
    """What an eye's frames measured, before focusing on the light is allowed for."""

    res: EyeResult  # filled with everything measured; the output fields are set by gate_eye
    done: bool  # already final: nothing usable was measured
    t: ScreeningThresholds
    acc: float
    reading: EyeReading = NO_READING
    has_obs: bool = False
    n_quant: int = 0
    n_intervals: int = 0
    dist: Optional[RefractionDistribution] = None
    reading_probs: Optional[ClassProbabilities] = None  # the reading on its own, as if the eyes had not focused
    reading_half: Optional[float] = None  # the 95% half-width of the reading on its own (D)


def measure_eye(
    eye: EyeSide,
    frames: list[FrameRecord],
    age_group: str,
    calibrated: bool,
    cfg: GatingConfig,
) -> EyeMeasurement:
    t = thresholds_for_age(age_group)  # type: ignore[arg-type]
    acc_sd = ACCOMMODATION_SD.get(age_group, ACCOMMODATION_SD["unknown"])
    usable = [f for f in frames if f.quality.usable and f.estimate is not None and f.estimate.meridian_deg is not None]
    res = EyeResult(eye=eye, output_level="repeat", message="", n_frames=len(frames), n_usable_frames=len(usable))
    qs = [f.quality.score for f in frames]
    if qs:
        res.median_quality = float(np.median(qs))
        grades = [f.quality.grade for f in usable] or [f.quality.grade for f in frames]
        order = ["excellent", "acceptable", "poor", "reject"]
        res.quality_grade = sorted(grades, key=order.index)[len(grades) // 2]
    lum = [f.features.reflex_mean_luma for f in usable if f.features.reflex_mean_luma]
    res.reflex_mean_luma = float(np.median(lum)) if lum else None

    if not usable:
        res.message = "No frame passed quality control. Repeat the measurement (see capture guidance)."
        return EyeMeasurement(res, True, t, acc_sd)

    groups: dict[float, list[FrameRecord]] = defaultdict(list)
    for f in usable:
        groups[_bin_meridian(f.estimate.meridian_deg)].append(f)  # type: ignore[union-attr,arg-type]

    obs: list[MeridionalObservation] = []
    intervals: list[tuple[float, float, float]] = []  # (meridian, lo, hi)
    for m, fs in sorted(groups.items()):
        q = [f.estimate for f in fs if f.estimate and f.estimate.status == "quantitative" and f.estimate.power_d is not None]
        iv = [f.estimate for f in fs if f.estimate and f.estimate.status == "interval" and f.estimate.interval_d]
        summ = MeridianSummary(meridian_deg=m, n_frames=len(fs), n_usable=len(fs), status="insufficient")
        if len(q) >= cfg.min_usable_frames_per_meridian and len(q) >= len(iv):
            p = np.array([e.power_d for e in q])  # type: ignore[misc]
            s2 = np.array([e.sigma_d**2 for e in q])  # type: ignore[operator]
            tsd = _robust_sd(p)
            n = len(p)
            var = float(np.median(s2)) * (1.0 / n + RHO_SYSTEMATIC) + tsd**2 / n
            summ.status, summ.power_d, summ.sigma_d = "quantitative", float(np.median(p)), math.sqrt(var)
            summ.temporal_sd_d, summ.frame_powers = tsd, [float(v) for v in p]
            obs.append(MeridionalObservation(m, summ.power_d, summ.sigma_d))
        elif len(iv) >= cfg.min_usable_frames_per_meridian:
            lo = float(np.median([e.interval_d[0] for e in iv]))  # type: ignore[index]
            hi = float(np.median([e.interval_d[1] for e in iv]))  # type: ignore[index]
            summ.status, summ.interval_d = "interval", (lo, hi)
            intervals.append((m, lo, hi))
        res.meridians.append(summ)

    if not obs and not intervals:
        res.message = (
            f"Too few usable frames per meridian (need {cfg.min_usable_frames_per_meridian}). Repeat the measurement."
        )
        return EyeMeasurement(res, True, t, acc_sd)

    if obs:
        # Interval (dead-zone) meridians are inequality constraints: they only
        # add information when the fit predicts a power outside the interval,
        # in which case a pseudo-observation pins it to the nearest bound.
        post = fit_power_vector(obs)
        for _ in range(2):
            extra = []
            for m, lo, hi in intervals:
                pred = post.power_vector.power_in_meridian(m)
                if pred < lo or pred > hi:
                    extra.append(MeridionalObservation(m, lo if pred < lo else hi, INTERVAL_BOUND_SD))
            if not extra:
                break
            post = fit_power_vector(obs + extra)
    else:
        # Only dead-zone information: uniform interval -> moment-matched Gaussian.
        post = fit_power_vector([MeridionalObservation(m, 0.5 * (lo + hi), (hi - lo) / math.sqrt(12.0))
                                 for m, lo, hi in intervals])
    n_quant = count_distinct_meridians([o.meridian_deg for o in obs])
    cal_sd = cfg.calibration_sd_calibrated if calibrated else cfg.calibration_sd_uncalibrated
    post.cov[0, 0] += acc_sd**2 + cal_sd**2
    dist = sample_refraction(post)
    M, J0, J45 = (float(v) for v in post.mean)
    sd = post.sd
    se_sd = float(sd[0])
    res.power_vector = {"M": M, "J0": J0, "J45": J45}
    res.power_vector_sd = {"M": float(sd[0]), "J0": float(sd[1]), "J45": float(sd[2])}

    if obs:
        reading_probs = class_probabilities(M, se_sd, t)
        reading = EyeReading("reading", mean_d=M, sd_d=se_sd)
    else:
        lo_all = min(iv[1] for iv in intervals)
        hi_all = max(iv[2] for iv in intervals)
        reading_probs = truncated_prior_class_probabilities(
            lo_all, hi_all, t, cfg.population_prior_mean, cfg.population_prior_sd
        )
        res.dead_zone_d = (lo_all, hi_all)
        reading = EyeReading("interval", lo_d=lo_all, hi_d=hi_all, sd_d=math.sqrt(acc_sd**2 + cal_sd**2))
    if n_quant >= cfg.min_distinct_meridians_for_cyl:
        # with fewer quantitative meridians this probability would only echo the prior
        res.astigmatism_probability = dist.p_cyl_ge.get(t.astigmatism_cyl, dist.p_cyl_ge.get(0.75))
    if not calibrated:
        res.notes.append("Device not calibrated: ±0.50 D calibration uncertainty included.")
    return EyeMeasurement(
        res, False, t, acc_sd, reading=reading, has_obs=bool(obs), n_quant=n_quant, n_intervals=len(intervals),
        dist=dist, reading_probs=reading_probs,
        reading_half=0.5 * (dist.se_ci95[1] - dist.se_ci95[0]) if obs else None,
    )


CHILD = ("child_3_7", "child_8_12")


def gate_eye(  # noqa: C901
    m: EyeMeasurement,
    age_group: str,
    cfg: GatingConfig,
    focus: Optional[FocusPosterior],
    working_distance_m: float,
) -> EyeResult:
    """Sets what an eye's result says.

    With the focusing model, a number is released only when the eye's own
    refraction is pinned to the interval limit after allowing for focusing on
    the light; without it (a stage 1 capture), the reading is taken as it stands.
    """
    res, t, dist = m.res, m.t, m.dist
    if m.done or dist is None:
        return res
    ef = focus.eyes.get(res.eye) if focus else None
    probs = ef.class_probabilities if ef else m.reading_probs
    assert probs is not None
    res.class_probabilities = {"myopia": probs.myopia, "emmetropia": probs.emmetropia, "hyperopia": probs.hyperopia}
    fmt = format_diopters
    d = f"{working_distance_m:.2f}"
    half = m.reading_half
    shift = 0.0
    if ef and focus:
        half = 0.5 * (ef.ci95[1] - ef.ci95[0])
        res.refraction_range95 = ef.ci95
        g0, g1 = focus.focus_response
        res.notes += [
            f"Allows for the eyes focusing on the light {d} m away, which makes an eye read more myopic than it is: "
            f"by up to {focus.amplitude_d:.1f} D at this age, at {round(g0 * 100)}–{round(g1 * 100)}% of what the "
            "eye needs.",
            f"Drift in focusing of ±{m.acc:.2f} D (SD) included for this age group.",
        ]
    else:
        res.notes.append(
            "Not corrected for focusing on the light: the reading is the eye as the camera saw it, focusing "
            f"included. Drift in focusing of ±{m.acc:.2f} D (SD) included."
        )
    # focusing on the light can hide this much error above what the reading alone allows
    hidden = ef.ci95[1] - (dist.se_ci95[1] if m.has_obs else res.dead_zone_d[1]) if ef else 0.0  # type: ignore[index]
    can_hide = hidden >= 1
    # Where focusing can hide error, a class rests on the eye's range alone: the population's prior would
    # otherwise decide how much hyperopia is hidden, so emmetropia is never claimed for such an eye.
    if can_hide:
        assert ef is not None
        cls = "myopia" if ef.ci95[1] < t.myopia_se else "hyperopia" if ef.ci95[0] >= t.hyperopia_se else None
    else:
        cls = probs.label if probs.confidence >= cfg.min_class_confidence_screening else None
    pv = res.power_vector or {}

    if m.has_obs and half is not None and half <= cfg.max_se_ci_halfwidth_quantitative:
        se = ef.median_d if ef else pv["M"]
        shift = se - pv["M"]
        res.output_level = "quantitative"
        res.se_d, res.se_ci95 = se, ef.ci95 if ef else dist.se_ci95
        res.refractive_class = probs.label
        res.severity = severity_label(se, t)
        res.confidence = probs.confidence
        res.message = (
            "Quantitative spherical-equivalent estimate within the configured uncertainty limit, allowing for the "
            "eyes focusing on the light."
            if abs(shift) >= 0.05
            else "Quantitative spherical-equivalent estimate within the configured uncertainty limit."
        )
    elif ef and m.has_obs and can_hide:
        # focusing on the light is what leaves the eye's refraction open: a repeat would read the same
        res.focus_limited = True
        res.output_level = "screening"
        lo, hi = fmt(ef.ci95[0]), fmt(ef.ci95[1])
        if cls:
            res.refractive_class, res.confidence = cls, getattr(probs, cls)
        if cls == "myopia":
            res.message = (
                f"This eye is myopic, between {lo} and {hi}. The eyes could focus on the light {d} m away, which "
                "makes an eye read more myopic than it is by an amount this capture cannot show, so no number is given."
            )
        elif cls == "hyperopia":
            res.message = (
                f"This eye shows hyperopia even while it can focus on the light: {lo} or more. Finding how much "
                "needs an eye examination with eye drops."
            )
        else:
            exam = "an eye examination with eye drops" if age_group in CHILD else "an eye examination"
            open_ = (
                "emmetropic or hyperopic" if ef.ci95[0] >= t.myopia_se else "emmetropic, mildly myopic or hyperopic"
            )
            res.message = (
                f"This eye could focus on the light {d} m away, which makes it read more myopic than it is "
                f"(here {fmt(pv['M'])}) by an amount this capture cannot show. It is no more myopic than {lo}; "
                f"whether it is {open_} needs {exam}."
            )
    elif cls:
        res.output_level = "screening"
        res.refractive_class, res.confidence = cls, getattr(probs, cls)
        if m.has_obs:
            res.se_ci95 = ef.ci95 if ef else dist.se_ci95
            res.message = (
                f"Quantitative refraction unreliable (95% interval ±{half:.2f} D). Result suggests {cls}. "
                "Repeat measurement or obtain clinical refraction."
            )
        else:
            res.message = (
                "No photorefraction crescent detected in any meridian: the reading lies inside this setup's dead zone "
                f"({fmt(res.dead_zone_d[0])} to {fmt(res.dead_zone_d[1])}). Screening result only."  # type: ignore[index]
            )
    elif not m.has_obs:
        lo_d, hi_d = res.dead_zone_d  # type: ignore[misc]
        # the eye is no more myopic than the reading, give or take its drift and calibration
        floor = fmt(ef.ci95[0] if ef else lo_d)
        if can_hide:
            ruled = (
                f"myopia beyond {floor}, but an eye that can focus on the light can hide hyperopia here, and "
                "mild myopia cannot be told from emmetropia at this distance"
            )
        elif ef:
            ruled = (
                f"myopia beyond {floor} and hyperopia beyond {fmt(ef.ci95[1])}, but mild myopia cannot be told "
                "from emmetropia at this distance"
            )
        else:
            ruled = f"myopia beyond {floor}, but mild myopia cannot be told from emmetropia at this distance"
        res.output_level = "screening"
        res.message = (
            f"No crescent detected: the reading lies between {fmt(lo_d)} and {fmt(hi_d)} in all measured meridians. "
            f"That rules out {ruled}. Optional: repeat at 1.5 m, or obtain clinical refraction."
        )
        return res
    else:
        res.output_level = "repeat"
        res.message = (
            "Insufficient confidence for any refractive category. Repeat measurement in a darker room "
            "at the guided distance, or obtain clinical refraction."
        )
        return res

    # --- astigmatism (gated) ---------------------------------------------
    cyl_width = dist.cyl_ci95[1] - dist.cyl_ci95[0]
    can_quantify_cyl = (
        cfg.astigmatism_quantification_enabled
        and res.output_level == "quantitative"
        and m.n_quant >= cfg.min_distinct_meridians_for_cyl
        and cyl_width <= cfg.max_cyl_ci_width
        and (dist.point.cyl > -0.25 or dist.axis_sd_deg <= cfg.max_axis_sd_deg)
    )
    if can_quantify_cyl:
        # focusing moves the sphere with the spherical equivalent and leaves the cylinder alone
        res.astigmatism_status = "quantified"
        res.sph_d = dist.point.sph + shift
        res.sph_ci95 = (dist.sph_ci95[0] + shift, dist.sph_ci95[1] + shift)
        res.cyl_d, res.cyl_ci95 = dist.point.cyl, dist.cyl_ci95
        if dist.point.axis is not None and dist.point.cyl <= -0.25:
            res.axis_deg = dist.point.axis
            res.axis_uncertainty_deg = dist.axis_sd_deg * 1.96
    elif m.n_quant >= 2 or (m.n_quant >= 1 and m.n_intervals):
        res.astigmatism_status = "screening_only"
        if not cfg.astigmatism_quantification_enabled:
            res.notes.append("CYL/AXIS quantification is disabled until validated on controlled multi-meridian data.")
    else:
        res.notes.append("Only one meridian measured: astigmatism not assessed (prior used).")
    return res


def working_distance(frames: list[FrameRecord]) -> float:
    """The working distance the frames measured: the median of their distances, or 1 m with none."""
    d = [
        f.metadata.working_distance_m
        for f in frames
        if f.quality.usable and f.estimate is not None and f.estimate.meridian_deg is not None
        and math.isfinite(f.metadata.working_distance_m) and f.metadata.working_distance_m > 0
    ]
    return float(np.median(d)) if d else 1.0


def fuse_eye(
    eye: EyeSide,
    frames: list[FrameRecord],
    age_group: str,
    calibrated: bool,
    cfg: GatingConfig,
    focus_model: bool = True,
) -> EyeResult:
    """One eye on its own: its fellow is taken from the population, given this eye."""
    m = measure_eye(eye, frames, age_group, calibrated, cfg)
    d = working_distance(frames)
    focus = None
    if focus_model and not m.done:
        readings = {"OD": NO_READING, "OS": NO_READING, eye: m.reading}
        focus = focus_posterior(readings, age_group, d, m.t, cfg.focus_config())
    return gate_eye(m, age_group, cfg, focus, d)


def focus_model_for(estimator_kind: str, learned_target: Optional[str] = None) -> bool:
    """Whether a report allows for the eyes focusing on the light, unless told otherwise.

    It does for readings of the eye as the camera saw it: the physics, and a learned model whose target was what
    the camera saw (``optical``, as the simulator gives).  A model that learned clinical refractions has also
    learned how its training eyes focused, so its readings are not corrected a second time; a model that does not
    say what it learned is taken to be one of those.
    """
    return estimator_kind != "ml" or learned_target == "optical"


def build_report(  # noqa: C901
    frames: list[FrameRecord],
    age_group: str,
    device_id: str,
    calibration_version: str,
    estimator_name: str,
    estimator_version: str,
    estimator_kind: str,
    extractor_version: str,
    cfg: GatingConfig = GatingConfig(),
    symptoms_reported: bool = False,
    focus_model: Optional[bool] = None,
) -> AssessmentReport:
    """Both eyes' results.

    `focus_model=False` takes each reading as it stands: a capture through a stage 1 trial lens, where the
    point is the eye as the camera saw it.  It defaults to `focus_model_for(estimator_kind)`: on, except for a
    learned estimator, whose caller says when its model learned what the camera saw.
    """
    if focus_model is None:
        focus_model = focus_model_for(estimator_kind)
    simulated = any(f.metadata.simulated for f in frames)
    if simulated and not all(f.metadata.simulated for f in frames):
        raise ValueError("Mixing simulated and real frames in one report is not allowed.")
    calibrated = calibration_version != "uncalibrated"
    ms = {
        e: measure_eye(e, [f for f in frames if f.metadata.eye == e], age_group, calibrated, cfg)  # type: ignore[arg-type]
        for e in ("OD", "OS")
    }
    d = working_distance(frames)
    # the eyes focus together, so the model reads both eyes at once
    focus = (
        focus_posterior({e: m.reading for e, m in ms.items()}, age_group, d, ms["OD"].t, cfg.focus_config())
        if focus_model
        else None
    )
    eyes = {e: gate_eye(m, age_group, cfg, focus, d) for e, m in ms.items()}
    rep = AssessmentReport(
        simulated=simulated,
        eyes=eyes,
        provenance=Provenance(
            model_name=estimator_name, model_version=estimator_version, estimator_kind=estimator_kind,
            calibration_version=calibration_version, device_profile=device_id, extractor_version=extractor_version,
        ),
        focus=FocusSummary(
            working_distance_m=d, light_d=focus.light_d, amplitude_d=focus.amplitude_d,
            focus_response=focus.focus_response, p_focusing=focus.p_focusing, mean_focus_d=focus.mean_focus_d,
        ) if focus else None,
    )
    t = thresholds_for_age(age_group)  # type: ignore[arg-type]
    od, os_ = eyes["OD"], eyes["OS"]
    reasons: list[str] = []
    if od.power_vector and os_.power_vector and od.output_level != "repeat" and os_.output_level != "repeat":
        a, b = od.power_vector["M"], os_.power_vector["M"]
        sa, sb = od.power_vector_sd["M"], os_.power_vector_sd["M"]  # type: ignore[index]
        rep.se_difference_d = a - b
        # accommodation is largely common to both eyes; remove its shared part from the difference
        acc = ACCOMMODATION_SD.get(age_group, ACCOMMODATION_SD["unknown"])
        sa2, sb2 = math.sqrt(max(sa**2 - acc**2 / 2, 0.01)), math.sqrt(max(sb**2 - acc**2 / 2, 0.01))
        rep.anisometropia_probability = anisometropia_probability(a, sa2, b, sb2, t.anisometropia_se)
        if rep.anisometropia_probability >= 0.5:
            reasons.append("Significant difference between eyes (possible anisometropia).")
    if od.reflex_mean_luma and os_.reflex_mean_luma:
        ratio = max(od.reflex_mean_luma, os_.reflex_mean_luma) / max(min(od.reflex_mean_luma, os_.reflex_mean_luma), 1e-6)
        rep.reflex_asymmetry_ratio = ratio
        if ratio >= cfg.reflex_asymmetry_ratio:
            rep.reflex_asymmetry_flag = True
            reasons.append(
                "Red-reflex brightness differs between eyes. This can have causes other than refractive error "
                "and needs a professional eye examination."
            )
    for r in (od, os_):
        if r.output_level == "repeat":
            reasons.append(f"{r.eye}: measurement unreliable - repeat or obtain clinical refraction.")
        elif r.confidence is not None and r.confidence < 0.9:
            reasons.append(f"{r.eye}: confidence below 90%.")
        if r.power_vector and (r.power_vector["M"] <= t.high_myopia_se or r.power_vector["M"] >= t.high_hyperopia_se):
            reasons.append(f"{r.eye}: possible high refractive error.")
        if r.astigmatism_probability is not None and r.astigmatism_probability >= 0.7:
            reasons.append(f"{r.eye}: astigmatism likely.")
    if symptoms_reported:
        reasons.append("Visual symptoms reported.")
    rep.referral_reasons = reasons

    labels = [r.refractive_class for r in (od, os_) if r.refractive_class]
    # an eye with a range but no class: no crescent, or a reading that focusing on the light leaves open
    ranged = [r for r in (od, os_) if r.output_level == "screening" and r.refractive_class is None]
    if not labels and ranged:
        rep.interpretation = "No refractive error this method can measure at this distance."
        if focus and (focus.p_focusing >= 0.05 or any(r.focus_limited for r in ranged)):
            rep.interpretation += " An eye that can focus on the light hides hyperopia and mild myopia from it."
        if len(ranged) < 2:
            rep.interpretation += " Repeat the measurement for the other eye."
    elif not labels:
        rep.interpretation = "No reliable refractive pattern could be determined. Please repeat the measurement."
    elif all(lb == "emmetropia" for lb in labels):
        rep.interpretation = "Measurements do not show a significant spherical refractive error within this method's limits."
    else:
        kinds = sorted({lb for lb in labels if lb != "emmetropia"})
        rep.interpretation = f"Your measurements show a pattern consistent with {' and '.join(kinds)} refractive error."
    # an eye whose range, focusing allowed for, reaches hyperopia has not had it ruled out
    if focus and age_group in CHILD and any(
        r.output_level != "repeat" and r.refraction_range95 is not None and r.refraction_range95[1] >= t.hyperopia_se
        for r in (od, os_)
    ):
        rep.interpretation += (
            " In children, hyperopia is usually only found with eye drops (a cycloplegic refraction); this capture "
            "does not rule it out."
        )
    if simulated:
        rep.interpretation = "SIMULATED DATA. " + rep.interpretation
    return rep
