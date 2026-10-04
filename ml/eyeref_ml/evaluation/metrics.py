"""Validation metrics for refraction estimates (docs/VALIDATION_PROTOCOL.md)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Optional

import numpy as np
from eyeref.optics.power_vector import circular_axis_error
from sklearn.metrics import roc_auc_score

from .. import __version__  # noqa: F401


def dioptric_metrics(pred: Sequence[float], true: Sequence[float]) -> dict[str, float]:
    p, t = np.asarray(pred, float), np.asarray(true, float)
    ok = np.isfinite(p) & np.isfinite(t)
    e = p[ok] - t[ok]
    if e.size == 0:
        return {"n": 0}
    a = np.abs(e)
    return {
        "n": int(e.size),
        "mae": float(a.mean()),
        "rmse": float(np.sqrt((e**2).mean())),
        "bias": float(e.mean()),
        "within_0_25": float((a <= 0.25 + 1e-9).mean()),
        "within_0_50": float((a <= 0.50 + 1e-9).mean()),
        "within_1_00": float((a <= 1.00 + 1e-9).mean()),
        "pearson_r": float(np.corrcoef(p[ok], t[ok])[0, 1]) if e.size > 2 and np.std(p[ok]) > 0 else float("nan"),
    }


def axis_metrics(pred_axis: Sequence[float], true_axis: Sequence[float], true_cyl: Sequence[float],
                 min_cyl: float = 0.75) -> dict[str, float]:
    """Circular axis error, only for eyes with |true cyl| >= min_cyl (axis is meaningless otherwise)."""
    errs = [
        circular_axis_error(p, t)
        for p, t, c in zip(pred_axis, true_axis, true_cyl, strict=True)
        if p is not None and t is not None and np.isfinite(p) and np.isfinite(t) and abs(c) >= min_cyl
    ]
    if not errs:
        return {"n": 0}
    e = np.asarray(errs)
    return {
        "n": int(e.size),
        "mean_abs_error_deg": float(e.mean()),
        "median_abs_error_deg": float(np.median(e)),
        "within_5": float((e <= 5).mean()),
        "within_10": float((e <= 10).mean()),
        "within_20": float((e <= 20).mean()),
    }


def bland_altman(pred: Sequence[float], true: Sequence[float]) -> dict[str, object]:
    p, t = np.asarray(pred, float), np.asarray(true, float)
    ok = np.isfinite(p) & np.isfinite(t)
    p, t = p[ok], t[ok]
    if p.size < 3:
        return {"n": int(p.size)}
    d = p - t
    m = 0.5 * (p + t)
    sd = float(d.std(ddof=1))
    slope = float(np.polyfit(m, d, 1)[0])  # proportional bias
    idx = np.linspace(0, p.size - 1, min(p.size, 400)).astype(int)
    return {
        "n": int(p.size), "mean_diff": float(d.mean()), "sd_diff": sd,
        "loa_low": float(d.mean() - 1.96 * sd), "loa_high": float(d.mean() + 1.96 * sd),
        "proportional_bias_slope": slope,
        "points": [{"mean": float(m[i]), "diff": float(d[i])} for i in idx],
    }


def binary_screening(score: Sequence[float], truth: Sequence[bool], threshold: float) -> dict[str, float]:
    s, y = np.asarray(score, float), np.asarray(truth, bool)
    ok = np.isfinite(s)
    s, y = s[ok], y[ok]
    if s.size == 0:
        return {"n": 0}
    pred = s >= threshold
    tp, tn = int((pred & y).sum()), int((~pred & ~y).sum())
    fp, fn = int((pred & ~y).sum()), int((~pred & y).sum())

    def div(a: int, b: int) -> float:
        return a / b if b else float("nan")

    out = {
        "n": int(s.size), "prevalence": float(y.mean()), "tp": tp, "tn": tn, "fp": fp, "fn": fn,
        "sensitivity": div(tp, tp + fn), "specificity": div(tn, tn + fp),
        "ppv": div(tp, tp + fp), "npv": div(tn, tn + fn),
    }
    out["roc_auc"] = float(roc_auc_score(y, s)) if 0 < y.sum() < y.size else float("nan")
    return out


def roc_curve_points(score: Sequence[float], truth: Sequence[bool], n: int = 40) -> list[dict[str, float]]:
    from sklearn.metrics import roc_curve

    s, y = np.asarray(score, float), np.asarray(truth, bool)
    ok = np.isfinite(s)
    if not (0 < y[ok].sum() < ok.sum()):
        return []
    fpr, tpr, _ = roc_curve(y[ok], s[ok])
    idx = np.unique(np.linspace(0, fpr.size - 1, min(n, fpr.size)).astype(int))
    return [{"fpr": float(fpr[i]), "tpr": float(tpr[i])} for i in idx]


def rejection_analysis(grades: Sequence[str], abs_errors: Sequence[Optional[float]]) -> dict[str, object]:
    """Fraction rejected per grade and error of accepted vs. (hypothetically) rejected frames."""
    g = np.asarray(grades)
    e = np.asarray([np.nan if v is None else v for v in abs_errors], float)
    out: dict[str, object] = {"n": int(g.size)}
    for grade in ("excellent", "acceptable", "poor", "reject"):
        m = g == grade
        out[grade] = {"fraction": float(m.mean()) if g.size else 0.0,
                      "mae_if_used": float(np.nanmean(e[m])) if m.any() and np.isfinite(e[m]).any() else None}
    return out


def safe(v: float) -> Optional[float]:
    return None if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))) else v
