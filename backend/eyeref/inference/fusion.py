"""Multi-frame + multi-meridian fusion, uncertainty and output gating.

Error model (all SDs in dioptres) for one meridian with n usable frames::

    var_meridian = median(sigma_frame^2) * (1/n + RHO)   # partly systematic
                 + temporal_sd^2 / n                     # fixation/accommodation jitter

Common-mode terms that shift ALL meridians equally are added to the M variance
*after* the meridional fit (they do not inform astigmatism):

    var_M += accommodation_sd(age)^2 + calibration_sd^2

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
from datetime import UTC, datetime
from typing import Literal, Optional

import numpy as np
from pydantic import BaseModel, Field

from .. import __version__
from ..optics.classification import (
    ACCOMMODATION_SD,
    anisometropia_probability,
    class_probabilities,
    severity_label,
    thresholds_for_age,
    truncated_prior_class_probabilities,
)
from ..optics.meridional import MeridionalObservation, count_distinct_meridians, fit_power_vector, sample_refraction
from ..optics.power_vector import normalize_axis
from ..types import EyeSide, FrameRecord, OutputLevel

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


def _bin_meridian(m: float) -> float:
    return normalize_axis(round(normalize_axis(m) / MERIDIAN_BIN_DEG) * MERIDIAN_BIN_DEG)


def _robust_sd(x: np.ndarray) -> float:
    if x.size < 2:
        return 0.0
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


def fuse_eye(
    eye: EyeSide,
    frames: list[FrameRecord],
    age_group: str,
    calibrated: bool,
    cfg: GatingConfig,
) -> EyeResult:
    t = thresholds_for_age(age_group)  # type: ignore[arg-type]
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
        return res

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
        return res

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
    n_quant_meridians = count_distinct_meridians([o.meridian_deg for o in obs])
    acc_sd = ACCOMMODATION_SD.get(age_group, ACCOMMODATION_SD["unknown"])
    cal_sd = cfg.calibration_sd_calibrated if calibrated else cfg.calibration_sd_uncalibrated
    post.cov[0, 0] += acc_sd**2 + cal_sd**2
    dist = sample_refraction(post)
    M, J0, J45 = (float(v) for v in post.mean)
    sd = post.sd
    se_sd = float(sd[0])
    res.power_vector = {"M": M, "J0": J0, "J45": J45}
    res.power_vector_sd = {"M": float(sd[0]), "J0": float(sd[1]), "J45": float(sd[2])}

    if obs:
        probs = class_probabilities(M, se_sd, t)
    else:
        lo_all = min(iv[1] for iv in intervals)
        hi_all = max(iv[2] for iv in intervals)
        probs = truncated_prior_class_probabilities(lo_all, hi_all, t, cfg.population_prior_mean, cfg.population_prior_sd)
        res.dead_zone_d = (lo_all, hi_all)
    res.class_probabilities = {"myopia": probs.myopia, "emmetropia": probs.emmetropia, "hyperopia": probs.hyperopia}
    if n_quant_meridians >= cfg.min_distinct_meridians_for_cyl:
        # with fewer quantitative meridians this probability would only echo the prior
        res.astigmatism_probability = dist.p_cyl_ge.get(t.astigmatism_cyl, dist.p_cyl_ge.get(0.75))
    res.notes.append(
        f"Non-cycloplegic measurement: accommodation uncertainty of ±{acc_sd:.2f} D (SD) included for age group "
        f"'{age_group}'. True refraction may be more hyperopic than measured."
    )
    if not calibrated:
        res.notes.append("Device not calibrated: ±0.50 D calibration uncertainty included.")

    se_half = 0.5 * (dist.se_ci95[1] - dist.se_ci95[0])
    any_quant = any(m.status == "quantitative" for m in res.meridians)

    if any_quant and se_half <= cfg.max_se_ci_halfwidth_quantitative:
        res.output_level = "quantitative"
        res.se_d, res.se_ci95 = M, dist.se_ci95
        res.refractive_class = probs.label
        res.severity = severity_label(M, t)
        res.confidence = probs.confidence
        res.message = "Quantitative spherical-equivalent estimate within the configured uncertainty limit."
    elif probs.confidence >= cfg.min_class_confidence_screening:
        res.output_level = "screening"
        res.refractive_class = probs.label
        res.confidence = probs.confidence
        res.se_ci95 = dist.se_ci95
        res.message = (
            f"Quantitative refraction unreliable (95% interval ±{se_half:.2f} D). Result suggests "
            f"{probs.label}. Repeat measurement or obtain clinical refraction."
        )
        if not obs:
            res.se_ci95 = None
            res.message = (
                f"No photorefraction crescent detected in any meridian: refraction lies inside this setup's dead zone "
                f"({res.dead_zone_d[0]:+.2f} to {res.dead_zone_d[1]:+.2f} D). Screening result only."  # type: ignore[index]
            )
    elif not obs:
        res.output_level = "screening"
        res.message = (
            f"No crescent detected: refraction lies between {res.dead_zone_d[0]:+.2f} and {res.dead_zone_d[1]:+.2f} D "  # type: ignore[index]
            "in all measured meridians. This excludes larger refractive errors but cannot separate mild myopia from "
            "emmetropia at this distance. Optional: repeat at 1.5 m to narrow the dead zone, or obtain clinical refraction."
        )
        return res
    else:
        res.output_level = "repeat"
        res.class_probabilities = res.class_probabilities
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
        and n_quant_meridians >= cfg.min_distinct_meridians_for_cyl
        and cyl_width <= cfg.max_cyl_ci_width
        and (dist.point.cyl > -0.25 or dist.axis_sd_deg <= cfg.max_axis_sd_deg)
    )
    if can_quantify_cyl:
        res.astigmatism_status = "quantified"
        res.sph_d, res.sph_ci95 = dist.point.sph, dist.sph_ci95
        res.cyl_d, res.cyl_ci95 = dist.point.cyl, dist.cyl_ci95
        if dist.point.axis is not None and dist.point.cyl <= -0.25:
            res.axis_deg = dist.point.axis
            res.axis_uncertainty_deg = dist.axis_sd_deg * 1.96
    elif n_quant_meridians >= 2 or (n_quant_meridians >= 1 and intervals):
        res.astigmatism_status = "screening_only"
        if not cfg.astigmatism_quantification_enabled:
            res.notes.append("CYL/AXIS quantification is disabled until validated on controlled multi-meridian data.")
    else:
        res.notes.append("Only one meridian measured: astigmatism not assessed (prior used).")
    return res


def build_report(
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
) -> AssessmentReport:
    simulated = any(f.metadata.simulated for f in frames)
    if simulated and not all(f.metadata.simulated for f in frames):
        raise ValueError("Mixing simulated and real frames in one report is not allowed.")
    calibrated = calibration_version != "uncalibrated"
    eyes = {
        e: fuse_eye(e, [f for f in frames if f.metadata.eye == e], age_group, calibrated, cfg)  # type: ignore[arg-type]
        for e in ("OD", "OS")
    }
    rep = AssessmentReport(
        simulated=simulated,
        eyes=eyes,
        provenance=Provenance(
            model_name=estimator_name, model_version=estimator_version, estimator_kind=estimator_kind,
            calibration_version=calibration_version, device_profile=device_id, extractor_version=extractor_version,
        ),
    )
    t = thresholds_for_age(age_group)  # type: ignore[arg-type]
    od, os_ = eyes["OD"], eyes["OS"]
    reasons: list[str] = []
    if od.power_vector and os_.power_vector and od.output_level != "repeat" and os_.output_level != "repeat":
        a, b = od.power_vector["M"], os_.power_vector["M"]
        sa, sb = od.power_vector_sd["M"], os_.power_vector_sd["M"]  # type: ignore[index]
        rep.se_difference_d = a - b
        # accommodation is largely common to both eyes; remove its shared part from the difference
        acc = ACCOMMODATION_SD.get(age_group, 0.6)
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
    if not labels:
        rep.interpretation = "No reliable refractive pattern could be determined. Please repeat the measurement."
    elif all(lb == "emmetropia" for lb in labels):
        rep.interpretation = "Measurements do not show a significant spherical refractive error within this method's limits."
    else:
        kinds = sorted({lb for lb in labels if lb != "emmetropia"})
        rep.interpretation = f"Your measurements show a pattern consistent with {' and '.join(kinds)} refractive error."
    if simulated:
        rep.interpretation = "SIMULATED DATA. " + rep.interpretation
    return rep
