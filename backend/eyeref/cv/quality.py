"""Frame-quality model: interpretable sub-scores, hard rejections and a grade.

Bad frames must never produce refraction values: only frames graded
``excellent`` or ``acceptable`` are passed to the estimators.  Thresholds are
initial engineering choices, documented in docs/ARCHITECTURE.md, and are meant
to be re-tuned with the rejection-rate analysis in ml/eyeref_ml/evaluation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..types import CaptureMetadata, PhotorefractionFeatures, QualityAssessment, QualitySubscores
from .segmentation import EyeSegmentation, luma


@dataclass(frozen=True)
class QualityConfig:
    min_pupil_mm: float = 3.0
    good_pupil_mm: float = 5.0
    max_yaw_deg: float = 15.0
    max_pitch_deg: float = 15.0
    max_gaze_offset_norm: float = 0.55
    target_distance_m: float = 1.0
    distance_tolerance_m: float = 0.35
    min_sharpness: float = 0.0008
    good_sharpness: float = 0.004
    max_motion_px: float = 4.0
    min_pupil_coverage: float = 0.75
    #: the pupil's width in the camera's own pixels below which the crescent cannot be measured. Simulated, a
    #: phone's 1080p video at 1 m (about 17 px across the iris, 7-9 px across the pupil) misreads a frame by
    #: 0.7 D on average and one in four by more than 1 D; at 24 px across the iris it is 0.2 D (docs/PHOTOREFRACTION.md)
    min_pupil_camera_px: float = 9.0
    max_glare_fraction: float = 0.25


def _ramp(x: float, bad: float, good: float) -> float:
    if good == bad:
        return 1.0 if x >= good else 0.0
    t = (x - bad) / (good - bad)
    return float(min(1.0, max(0.0, t)))


def sharpness_metric(img_rgb: np.ndarray, region: Optional[np.ndarray] = None, upsample: float = 1.0) -> float:
    """Variance of the 4-neighbour Laplacian of luma over the region's interior pixels, at the camera's own pixel
    spacing.

    An enlarged crop's smooth in-between pixels would otherwise read as blur in a sharp picture, so the Laplacian
    takes pixels round(upsample) apart, and the rest of the enlargement is scaled out (a second difference falls
    with the square of the spacing). Twin of laplacianVariance in apps/web/src/lib/cv/image.ts.
    """
    g = luma(img_rgb).astype(np.float64)
    s = max(1, round(upsample))
    h, w = g.shape
    if h <= 2 * s or w <= 2 * s:
        return 0.0
    c = g[s:h - s, s:w - s]
    lap = g[s:h - s, : w - 2 * s] + g[s:h - s, 2 * s:] + g[: h - 2 * s, s:w - s] + g[2 * s:, s:w - s] - 4 * c
    if region is not None and region[s:h - s, s:w - s].any():
        lap = lap[region[s:h - s, s:w - s]]
    return float(lap.var()) * (max(upsample, 1.0) / s) ** 4 if lap.size else 0.0


def assess_quality(
    img_rgb: np.ndarray,
    seg: Optional[EyeSegmentation],
    features: PhotorefractionFeatures,
    meta: CaptureMetadata,
    cfg: QualityConfig = QualityConfig(),
) -> QualityAssessment:
    s = QualitySubscores()
    hard: list[str] = []
    adv: list[str] = []

    if seg is None or features.pupil is None:
        hard.append("pupil_not_found")
        return QualityAssessment(score=0.0, grade="reject", subscores=s, hard_failures=hard)

    h, w = img_rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    iris_region = (xx - seg.iris.cx) ** 2 + (yy - seg.iris.cy) ** 2 <= (1.1 * seg.iris.r) ** 2

    sharp = sharpness_metric(img_rgb, iris_region, meta.crop_upsample)
    s.sharpness = _ramp(sharp, cfg.min_sharpness, cfg.good_sharpness)
    if sharp < cfg.min_sharpness:
        hard.append("image_blurred")

    L = luma(img_rgb)
    mean_l = float(L[iris_region].mean())
    s.exposure = _ramp(mean_l, 0.04, 0.15) * _ramp(-mean_l, -0.85, -0.6)
    clipped = (img_rgb[..., 0] >= 250) & seg.pupil_mask & ~seg.glint_mask
    clip_frac = float(clipped.sum() / max(seg.pupil_mask.sum(), 1))
    s.saturation = _ramp(-clip_frac, -0.25, -0.03)
    if clip_frac > 0.25:
        hard.append("reflex_saturated")
        adv.append("Reduce exposure or increase distance: red reflex is clipped.")

    glare_frac = float((seg.glint_mask & seg.pupil_mask).sum() / max(seg.pupil_mask.sum(), 1))
    s.glare = _ramp(-glare_frac, -0.25, -0.06)
    if glare_frac > cfg.max_glare_fraction:
        hard.append("excessive_glare")

    s.pupil_visibility = _ramp(seg.pupil_coverage, 0.6, 0.92)
    if seg.pupil_coverage < cfg.min_pupil_coverage:
        hard.append("pupil_occluded")
        adv.append("Pupil partly covered (eyelid/lashes). Ask the subject to open eyes wide.")

    if 2 * features.pupil.r / meta.crop_upsample < cfg.min_pupil_camera_px:
        hard.append("too_few_pixels")
        adv.append("Too few camera pixels across the pupil: zoom in, or use a higher camera resolution.")

    pd = features.pupil_diameter_mm or 0.0
    s.pupil_size = _ramp(pd, cfg.min_pupil_mm, cfg.good_pupil_mm)
    if pd < cfg.min_pupil_mm:
        hard.append("pupil_too_small")
        adv.append("Pupil too small: dim the room and wait 1-2 minutes for dark adaptation.")

    hp = meta.head_pose
    s.head_pose = min(_ramp(-abs(hp.yaw_deg), -cfg.max_yaw_deg, -5), _ramp(-abs(hp.pitch_deg), -cfg.max_pitch_deg, -5))
    if abs(hp.yaw_deg) > cfg.max_yaw_deg or abs(hp.pitch_deg) > cfg.max_pitch_deg:
        hard.append("head_rotated")

    if features.glint_offset_norm is not None:
        g = math.hypot(*features.glint_offset_norm)
        s.gaze = _ramp(-g, -cfg.max_gaze_offset_norm, -0.2)
        if g > cfg.max_gaze_offset_norm:
            hard.append("gaze_off_axis")
    else:
        s.gaze = 0.5
        adv.append("No corneal reflex found; gaze could not be verified.")

    if meta.motion_px_per_frame is not None:
        s.motion = _ramp(-meta.motion_px_per_frame, -cfg.max_motion_px, -1.0)
        if meta.motion_px_per_frame > cfg.max_motion_px:
            hard.append("motion")

    dd = abs(meta.working_distance_m - cfg.target_distance_m)
    s.distance = _ramp(-dd, -cfg.distance_tolerance_m, -0.1)
    if dd > cfg.distance_tolerance_m:
        hard.append("distance_out_of_range")

    if meta.illumination in ("none",):
        s.illumination = 0.0
        adv.append("No eccentric light source: photorefraction is not possible.")
    else:
        s.illumination = _ramp(features.reflex_mean_luma or 0.0, 0.05, 0.18)
        if (features.reflex_mean_luma or 0) < 0.05:
            hard.append("no_red_reflex")

    weights = {
        "sharpness": 1.2, "exposure": 0.8, "saturation": 0.8, "glare": 0.8,
        "pupil_visibility": 1.2, "pupil_size": 1.2, "head_pose": 0.8, "gaze": 1.0,
        "motion": 0.8, "distance": 0.8, "illumination": 1.0,
    }
    vals = s.model_dump()
    # weighted geometric mean: one very poor factor drags the score down
    logsum = sum(w * math.log(max(vals[k], 0.02)) for k, w in weights.items())
    score = math.exp(logsum / sum(weights.values()))
    if hard:
        grade = "reject"
    elif score >= 0.85:
        grade = "excellent"
    elif score >= 0.65:
        grade = "acceptable"
    elif score >= 0.45:
        grade = "poor"
    else:
        grade = "reject"
    return QualityAssessment(score=round(score, 4), grade=grade, subscores=s, hard_failures=hard, advisories=adv)
