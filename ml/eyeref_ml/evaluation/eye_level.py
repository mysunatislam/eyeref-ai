"""Eye-level evaluation: per-frame predictions -> runtime fusion -> metrics.

Fuses each session's two eyes as eyeref.inference.fusion.build_report does
(measure_eye, the focusing model over both eyes, gate_eye), so the evaluated
results are exactly what the product would show: a number only where the gate
releases one, and a range where focusing on the light could hide 1 D or more.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
from eyeref.inference.focus import focus_posterior
from eyeref.inference.fusion import GatingConfig, gate_eye, measure_eye, working_distance
from eyeref.optics.classification import thresholds_for_age
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


def _record(r: pd.Series, eye: str, model_name: str) -> FrameRecord:
    grade = r.quality_grade if isinstance(r.quality_grade, str) else "reject"
    q = QualityAssessment(score=float(r.quality_score), grade=grade, subscores=QualitySubscores())
    lo, hi = r.get("pred_interval_lo", np.nan), r.get("pred_interval_hi", np.nan)
    if np.isfinite(lo) and np.isfinite(hi):
        est = MeridionalEstimate(meridian_deg=float(r.meridian_deg), status="interval", interval_d=(float(lo), float(hi)),
                                 estimator=model_name, estimator_version="eval")
    else:
        est = MeridionalEstimate(meridian_deg=float(r.meridian_deg), status="quantitative", power_d=float(r.pred_mu),
                                 sigma_d=float(max(r.pred_sigma, 0.05)), estimator=model_name, estimator_version="eval")
    meta = CaptureMetadata(eye=eye, simulated=bool(r.simulated), working_distance_m=float(r.working_distance_m))
    return FrameRecord(metadata=meta, features=PhotorefractionFeatures(reflex_mean_luma=r.get("f_reflex_mean_luma")),
                       quality=q, estimate=est)


def dead_zone_intervals(frames: pd.DataFrame) -> np.ndarray:
    """Each frame's dead zone where it shows no crescent, as the app's physics estimator reports it: an interval,
    not a number (NaN for a frame with a crescent)."""
    dz = (frames.phys_in_dead_zone.to_numpy() > 0.5) & (frames.dz_half.to_numpy() > 0)
    centre, half = frames.dz_centre.to_numpy(), frames.dz_half.to_numpy()
    return np.column_stack([np.where(dz, centre - half, np.nan), np.where(dz, centre + half, np.nan)])


def fuse_predictions(df: pd.DataFrame, mu: np.ndarray, sigma: np.ndarray, model_name: str,
                     gating: GatingConfig, focus_model: bool = False,
                     intervals: np.ndarray | None = None) -> pd.DataFrame:
    """One row per eye with what the app would show for it.

    `focus_model` allows for the eyes focusing on the light, as the app does for readings of the eye as the
    camera saw it: the physics, and a model that learned what the camera saw.  A model that learned clinical
    refractions has learned its training eyes' focusing, so it goes without (eyeref.inference.fusion.focus_model_for).
    `intervals` (lo, hi per frame, NaN where there is a reading) gives frames a dead-zone interval instead of
    a number, as the physics does without a crescent.
    """
    df = df.assign(pred_mu=mu, pred_sigma=sigma)
    if intervals is not None:
        df = df.assign(pred_interval_lo=intervals[:, 0], pred_interval_hi=intervals[:, 1])
    rows: list[dict[str, Any]] = []
    for session, s in df.groupby("session_id"):
        age_group = s.iloc[0].age_group
        recs = {eye: [_record(r, eye, model_name) for _, r in g.iterrows()] for eye, g in s.groupby("eye")}
        ms = {eye: measure_eye(eye, recs.get(eye, []), age_group, True, gating) for eye in ("OD", "OS")}
        d = working_distance([f for fs in recs.values() for f in fs])
        # the eyes focus together, so the model reads both eyes at once
        focus = (focus_posterior({e: m.reading for e, m in ms.items()}, age_group, d, thresholds_for_age(age_group),
                                 gating.focus_config()) if focus_model else None)
        for eye, g in s.groupby("eye"):
            res = gate_eye(ms[eye], age_group, gating, focus, d)
            ef = focus.eyes.get(eye) if focus else None
            # ungated research estimate of sph/cyl/axis from the same usable frames
            usable = g[g.quality_usable.astype(bool)]
            sph = cyl = axis = p_ast = np.nan
            if len(usable) >= 3:
                post = fit_power_vector([MeridionalObservation(float(a), float(b), float(c)) for a, b, c in
                                         zip(usable.meridian_deg, usable.pred_mu, usable.pred_sigma, strict=True)])
                dist = sample_refraction(post, n=1500)
                sph, cyl = dist.point.sph, dist.point.cyl
                axis = dist.point.axis if dist.point.axis is not None else np.nan
                p_ast = dist.p_cyl_ge.get(0.75, np.nan)
            first = g.iloc[0]
            pv = res.power_vector or {}
            cp = res.class_probabilities or {}
            rng95 = res.refraction_range95
            rows.append({
                "session_id": session, "eye": eye, "subject_id": first.subject_id, "device_id": first.device_id,
                "age_group": age_group, "skin_idx": first.get("skin_idx", -1),
                "pupil_mm": float(np.nanmedian(g.pupil_diameter_mm)) if g.pupil_diameter_mm.notna().any() else np.nan,
                "distance_m": float(g.working_distance_m.median()),
                "gt_se": first.gt_se, "gt_sph": first.gt_sph, "gt_cyl": first.gt_cyl, "gt_axis": first.gt_axis,
                "gt_M": first.gt_M, "gt_J0": first.gt_J0, "gt_J45": first.gt_J45,
                "output_level": res.output_level,
                # the eye's own refraction: the focusing model's median where it ran, else the reading
                "pred_M": ef.median_d if ef else pv.get("M", np.nan), "reading_M": pv.get("M", np.nan),
                "pred_J0": pv.get("J0", np.nan), "pred_J45": pv.get("J45", np.nan),
                "pred_M_sd": (res.power_vector_sd or {}).get("M", np.nan),
                "pred_se_released": res.se_d if res.se_d is not None else np.nan,
                "se_ci_low": res.se_ci95[0] if res.se_ci95 else np.nan,
                "se_ci_high": res.se_ci95[1] if res.se_ci95 else np.nan,
                "range_low": rng95[0] if rng95 else np.nan, "range_high": rng95[1] if rng95 else np.nan,
                "focus_limited": bool(res.focus_limited), "refractive_class": res.refractive_class,
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


def _within(x: pd.Series, lo: pd.Series, hi: pd.Series) -> float | None:
    ok = lo.notna() & hi.notna()
    return float(((x >= lo) & (x <= hi))[ok].mean()) if ok.any() else None


def _true_class(eyes: pd.DataFrame) -> pd.Series:
    def one(r: pd.Series) -> str:
        t = thresholds_for_age(r.age_group)
        return "myopia" if r.gt_se <= t.myopia_se else "hyperopia" if r.gt_se >= t.hyperopia_se else "emmetropia"

    return eyes.apply(one, axis=1) if len(eyes) else pd.Series(dtype=str)


def eye_metrics(eyes: pd.DataFrame, frames: pd.DataFrame | None = None) -> dict[str, Any]:
    """`frames` carry the model's target `y`, so the rejection analysis scores what the model learned."""
    out: dict[str, Any] = {"n_eyes": int(len(eyes))}
    out["output_levels"] = eyes.output_level.value_counts(normalize=True).to_dict()
    out["se_all_eyes"] = dioptric_metrics(eyes.pred_M, eyes.gt_se)
    rel = eyes[eyes.output_level == "quantitative"]
    out["se_released_only"] = dioptric_metrics(rel.pred_se_released, rel.gt_se)
    out["se_ci95_coverage"] = _within(rel.gt_se, rel.se_ci_low, rel.se_ci_high)
    # an eye that focusing on the light leaves open gets a range: how often, and how often it holds the truth
    ranged = eyes[eyes.focus_limited.astype(bool)]
    out["ranges"] = {"n": int(len(ranged)), "fraction": float(len(ranged) / len(eyes)) if len(eyes) else None,
                     "coverage": _within(ranged.gt_se, ranged.range_low, ranged.range_high),
                     "coverage_all_eyes": _within(eyes.gt_se, eyes.range_low, eyes.range_high)}
    classed = eyes[eyes.refractive_class.notna()]
    truth = _true_class(classed)
    out["classes"] = {"n": int(len(classed)), "fraction": float(len(classed) / len(eyes)) if len(eyes) else None,
                      "accuracy": float((classed.refractive_class == truth).mean()) if len(classed) else None,
                      "wrong": {f"{c}_given": int(((classed.refractive_class == c) & (truth != c)).sum())
                                for c in ("myopia", "emmetropia", "hyperopia")}}
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
        err = (frames.pred_mu - frames.y).abs()
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
                             "fraction_quantitative": float((g.output_level == "quantitative").mean()),
                             "fraction_range": float(g.focus_limited.astype(bool).mean())}
                    for k, g in eyes.groupby(col)}
    return _f(out)
