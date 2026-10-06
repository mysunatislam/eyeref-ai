"""Eye-level evaluation: per-frame predictions -> runtime fusion -> metrics.

Uses eyeref.inference.fusion.fuse_eye unchanged, so evaluated numbers are
exactly what the product would show (including gating).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
from eyeref.inference.fusion import GatingConfig, fuse_eye
from eyeref.optics.meridional import MeridionalObservation, fit_power_vector, sample_refraction
from eyeref.types import (
    CaptureMetadata,
    FrameRecord,
    MeridionalEstimate,
    PhotorefractionFeatures,
    QualityAssessment,
    QualitySubscores,
)

from .. import __version__  # noqa: F401
from .metrics import (
    axis_metrics,
    binary_screening,
    bland_altman,
    dioptric_metrics,
    rejection_analysis,
    roc_curve_points,
)


def fuse_predictions(df: pd.DataFrame, mu: np.ndarray, sigma: np.ndarray, model_name: str,
                     gating: GatingConfig) -> pd.DataFrame:
    df = df.assign(pred_mu=mu, pred_sigma=sigma)
    rows: list[dict[str, Any]] = []
    for (session, eye), g in df.groupby(["session_id", "eye"]):
        recs = []
        for _, r in g.iterrows():
            grade = r.quality_grade if isinstance(r.quality_grade, str) else "reject"
            q = QualityAssessment(score=float(r.quality_score), grade=grade, subscores=QualitySubscores())
            est = MeridionalEstimate(meridian_deg=float(r.meridian_deg), status="quantitative",
                                     power_d=float(r.pred_mu), sigma_d=float(max(r.pred_sigma, 0.05)),
                                     estimator=model_name, estimator_version="eval")
            recs.append(FrameRecord(metadata=CaptureMetadata(eye=eye, simulated=bool(r.simulated)),
                                    features=PhotorefractionFeatures(reflex_mean_luma=r.get("f_reflex_mean_luma")),
                                    quality=q, estimate=est))
        first = g.iloc[0]
        # the model predicts each meridian's own refraction, as build_report assumes of a learned estimator,
        # so the readings are not allowed for focusing on the light a second time
        res = fuse_eye(eye, recs, first.age_group, calibrated=True, cfg=gating, focus_model=False)
        # ungated research estimate of sph/cyl/axis from the same usable frames
        usable = g[g.quality_usable.astype(bool)]
        sph = cyl = axis = p_ast = np.nan
        if len(usable) >= 3:
            post = fit_power_vector([MeridionalObservation(float(a), float(b), float(c))
                                     for a, b, c in zip(usable.meridian_deg, usable.pred_mu, usable.pred_sigma, strict=True)])
            dist = sample_refraction(post, n=1500)
            sph, cyl = dist.point.sph, dist.point.cyl
            axis = dist.point.axis if dist.point.axis is not None else np.nan
            p_ast = dist.p_cyl_ge.get(0.75, np.nan)
        pv = res.power_vector or {}
        cp = res.class_probabilities or {}
        rows.append({
            "session_id": session, "eye": eye, "subject_id": first.subject_id, "device_id": first.device_id,
            "age_group": first.age_group, "skin_idx": first.get("skin_idx", -1),
            "pupil_mm": float(np.nanmedian(g.pupil_diameter_mm)) if g.pupil_diameter_mm.notna().any() else np.nan,
            "distance_m": float(g.working_distance_m.median()),
            "gt_se": first.gt_se, "gt_sph": first.gt_sph, "gt_cyl": first.gt_cyl, "gt_axis": first.gt_axis,
            "gt_M": first.gt_M, "gt_J0": first.gt_J0, "gt_J45": first.gt_J45,
            "output_level": res.output_level, "pred_M": pv.get("M", np.nan), "pred_J0": pv.get("J0", np.nan),
            "pred_J45": pv.get("J45", np.nan), "pred_M_sd": (res.power_vector_sd or {}).get("M", np.nan),
            "pred_se_released": res.se_d if res.se_d is not None else np.nan,
            "se_ci_low": res.se_ci95[0] if res.se_ci95 else np.nan, "se_ci_high": res.se_ci95[1] if res.se_ci95 else np.nan,
            "p_myopia": cp.get("myopia", np.nan), "p_hyperopia": cp.get("hyperopia", np.nan), "p_astig": p_ast,
            "pred_sph": sph, "pred_cyl": cyl, "pred_axis": axis, "n_usable": res.n_usable_frames,
        })
    return pd.DataFrame(rows)


def _f(x: Any) -> Any:
    if isinstance(x, dict):
        return {k: _f(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_f(v) for v in x]
    if isinstance(x, (float, np.floating)):
        return None if not math.isfinite(float(x)) else float(x)
    if isinstance(x, np.integer):
        return int(x)
    return x


def eye_metrics(eyes: pd.DataFrame, frames: pd.DataFrame | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"n_eyes": int(len(eyes))}
    out["output_levels"] = eyes.output_level.value_counts(normalize=True).to_dict()
    out["se_all_eyes"] = dioptric_metrics(eyes.pred_M, eyes.gt_se)
    rel = eyes[eyes.output_level == "quantitative"]
    out["se_released_only"] = dioptric_metrics(rel.pred_se_released, rel.gt_se)
    ci_ok = rel.se_ci_low.notna()
    out["se_ci95_coverage"] = float(((rel.gt_se >= rel.se_ci_low) & (rel.gt_se <= rel.se_ci_high))[ci_ok].mean()) if ci_ok.any() else None
    out["sphere"] = dioptric_metrics(eyes.pred_sph, eyes.gt_sph)
    out["cylinder"] = dioptric_metrics(eyes.pred_cyl, eyes.gt_cyl)
    out["J0"] = dioptric_metrics(eyes.pred_J0, eyes.gt_J0)
    out["J45"] = dioptric_metrics(eyes.pred_J45, eyes.gt_J45)
    out["axis"] = axis_metrics(eyes.pred_axis, eyes.gt_axis, eyes.gt_cyl)
    out["bland_altman_se"] = bland_altman(eyes.pred_M, eyes.gt_se)
    out["screening_myopia"] = binary_screening(eyes.p_myopia, eyes.gt_se <= -0.5, 0.5)
    out["screening_myopia"]["roc"] = roc_curve_points(eyes.p_myopia, eyes.gt_se <= -0.5)
    out["screening_hyperopia"] = binary_screening(eyes.p_hyperopia, eyes.gt_se >= 0.5, 0.5)
    out["screening_astigmatism"] = binary_screening(eyes.p_astig, eyes.gt_cyl.abs() >= 0.75, 0.5)
    # anisometropia per session
    piv = eyes.pivot_table(index="session_id", columns="eye", values=["pred_M", "gt_se", "pred_M_sd"])
    if {"OD", "OS"} <= set(piv["pred_M"].columns):
        d_pred = (piv["pred_M"]["OD"] - piv["pred_M"]["OS"]).abs()
        d_true = (piv["gt_se"]["OD"] - piv["gt_se"]["OS"]).abs()
        out["anisometropia"] = binary_screening(d_pred, d_true >= 1.0, 1.0)
    if frames is not None and "pred_mu" in frames:
        err = (frames.pred_mu - frames.gt_power_meridian).abs()
        out["rejection"] = rejection_analysis(frames.quality_grade.fillna("reject"), err.tolist())
    return _f(out)


def subgroup_metrics(eyes: pd.DataFrame) -> dict[str, Any]:
    eyes = eyes.copy()
    eyes["refractive_range"] = pd.cut(eyes.gt_se, [-99, -6, -3, -0.5, 0.5, 3, 99],
                                      labels=["<=-6", "-6..-3", "-3..-0.5", "-0.5..+0.5", "+0.5..+3", ">+3"]).astype(str)
    eyes["pupil_bin"] = pd.cut(eyes.pupil_mm, [0, 4, 5, 6, 7, 99], labels=["<4", "4-5", "5-6", "6-7", ">7"]).astype(str)
    eyes["distance_bin"] = pd.cut(eyes.distance_m, [0, 0.9, 1.1, 99], labels=["<0.9", "0.9-1.1", ">1.1"]).astype(str)
    out: dict[str, Any] = {}
    for col in ("device_id", "age_group", "refractive_range", "pupil_bin", "distance_bin", "skin_idx"):
        out[col] = {str(k): {"n": int(len(g)), **dioptric_metrics(g.pred_M, g.gt_se),
                             "fraction_quantitative": float((g.output_level == "quantitative").mean())}
                    for k, g in eyes.groupby(col)}
    return _f(out)
