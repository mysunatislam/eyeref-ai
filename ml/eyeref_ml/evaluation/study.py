"""Validation study analysis of the research server's data (docs/VALIDATION_PROTOCOL.md).

Reads the eye-level export (``GET /api/dataset/export?level=eye``): one row per eye per visit, with what
the product released and the reference refractions measured at that visit. Reports, each with a 95%
confidence interval from a bootstrap over subjects:

* intention to screen: every eye that entered the protocol, by outcome;
* agreement with one reference method, for the eyes given a number;
* screening accuracy for myopia, hyperopia, astigmatism and anisometropia, with every eye counted, its
  2x2 table and its ROC curve;
* calibration of the class probabilities: a reliability table and the expected calibration error;
* repeatability, from the same eye measured more than once on the same day;
* release and agreement by device, age, refractive range, pupil size, distance, iris colour, pigmentation
  and sex.

    python -m eyeref_ml.evaluation.study eyeref_eyes.csv --reference autorefractor --out study.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from collections.abc import Callable, Hashable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd
from eyeref.optics.classification import thresholds_for_age
from eyeref.optics.power_vector import PowerVector, SphCylAxis, from_power_vector, to_corneal_plane, to_power_vector
from scipy.stats import rankdata

from .. import __version__
from .metrics import axis_metrics, dioptric_metrics

#: Best first (docs/DATASET.md). A lensmeter reads spectacles, not eyes, so it is never a reference.
REFERENCE_PRIORITY = ("cycloplegic", "subjective", "autorefractor", "retinoscopy", "trial_lens")
#: The protocol's four groups. Only the first two are screened; the others are referred.
OUTCOMES = ("quantitative", "screening", "repeat", "protocol_failure")
SCREENED = ("quantitative", "screening")
NUMERIC = ("pred_se", "pred_se_ci_low", "pred_se_ci_high", "pred_j0", "pred_j45", "pred_sph", "pred_cyl", "pred_axis",
           "p_myopia", "p_hyperopia", "p_astigmatism", "p_anisometropia", "n_usable_frames", "pupil_mm", "distance_m")
#: The product refers for astigmatism at this probability ("astigmatism likely"); for the rest at 0.5.
ASTIGMATISM_REFERRAL = 0.7
#: Subgroups the protocol reports, and the bands some of them are cut into.
SUBGROUPS = ("device_id", "age_group", "refractive_range", "pupil_band", "distance_band", "iris_color", "pigmentation",
             "sex")
BANDS = {
    "refractive_range": ("ref_se", [-99, -6, -3, -0.5, 0.5, 3, 99],
                         ["-6 or less", "-6 to -3", "-3 to -0.5", "-0.5 to +0.5", "+0.5 to +3", "over +3"]),
    "pupil_band": ("pupil_mm", [0, 4, 5, 6, 7, 99], ["4 mm or less", "4 to 5 mm", "5 to 6 mm", "6 to 7 mm", "over 7 mm"]),
    # the protocol captures at 1.0 m and 1.5 m
    "distance_band": ("distance_m", [0, 0.9, 1.1, 1.4, 1.6, 99],
                      ["0.9 m or less", "0.9 to 1.1 m", "1.1 to 1.4 m", "1.4 to 1.6 m", "over 1.6 m"]),
}
#: Above this |M| of the reference, both sides are compared at the cornea (the protocol's representation rule).
CORNEAL_PLANE_ABOVE_D = 4.0
DEFAULT_VERTEX_MM = 12.0
#: Bland and Altman's coefficient of repeatability, as a multiple of the within-subject SD (1.96 x sqrt 2).
COR_PER_SW = 2.77
#: What the web app's study page checks before reading a file (apps/web/src/lib/studyReport.ts).
REPORT_KIND, REPORT_FORMAT = "eyeref-study-report", 1


class StudyError(ValueError):
    """The export cannot be analysed as one study, and why."""


def load_export(path: str | Path) -> pd.DataFrame:
    p = Path(path)
    return pd.read_json(p, convert_dates=False) if p.suffix.lower() == ".json" else pd.read_csv(p)


def _num(row: pd.Series, col: str) -> float:
    v = row.get(col)
    return float(v) if v is not None and pd.notna(v) else math.nan


def _bool(v: Any) -> bool:
    return v.strip().lower() == "true" if isinstance(v, str) else bool(v)


def _reference(row: pd.Series, methods: Sequence[str]) -> dict[str, Any]:
    for method in methods:
        sph = _num(row, f"gt_{method}_sph")
        if math.isfinite(sph):
            cyl, vertex = _num(row, f"gt_{method}_cyl"), _num(row, f"gt_{method}_vertex_mm")
            return {"ref_method": method, "ref_sph": sph, "ref_cyl": cyl if math.isfinite(cyl) else 0.0,
                    "ref_axis": _num(row, f"gt_{method}_axis"),
                    "ref_vertex_mm": vertex if math.isfinite(vertex) else DEFAULT_VERTEX_MM}
    return {"ref_method": None, "ref_sph": math.nan, "ref_cyl": math.nan, "ref_axis": math.nan, "ref_vertex_mm": math.nan}


def _outcome(row: pd.Series) -> str:
    level = row.get("output_level")
    if not isinstance(level, str) or not _num(row, "n_usable_frames") > 0:
        return "protocol_failure"  # no result, or no usable capture
    return level


def _axis_or_none(v: float) -> Optional[float]:
    return v if math.isfinite(v) else None


def _compared(row: pd.Series) -> dict[str, Any]:
    """Reference and released values as compared: at the cornea when |M| of the reference exceeds 4 D.
    Sphere, cylinder and axis only where the gate released them, in minus cylinder."""
    ref = SphCylAxis(row["ref_sph"], row["ref_cyl"], _axis_or_none(_num(row, "ref_axis"))).in_convention("minus")
    j0, j45 = _num(row, "pred_j0"), _num(row, "pred_j45")
    pred = PowerVector(_num(row, "pred_se"), j0 if math.isfinite(j0) else 0.0, j45 if math.isfinite(j45) else 0.0)
    sph, cyl = _num(row, "pred_sph"), _num(row, "pred_cyl")
    rx = SphCylAxis(sph, cyl, _axis_or_none(_num(row, "pred_axis"))).in_convention("minus") if math.isfinite(
        sph + cyl) else None
    cornea = abs(to_power_vector(ref).M) > CORNEAL_PLANE_ABOVE_D
    if cornea:
        vertex = row["ref_vertex_mm"]
        ref = to_corneal_plane(ref, vertex)
        pred = to_power_vector(to_corneal_plane(from_power_vector(pred), vertex))
        rx = to_corneal_plane(rx, vertex) if rx else None
    r = to_power_vector(ref)
    nan = math.nan
    return {"corneal_plane": cornea, "cmp_ref_m": r.M, "cmp_ref_j0": r.J0, "cmp_ref_j45": r.J45, "cmp_pred_m": pred.M,
            "cmp_pred_j0": pred.J0 if math.isfinite(j0) else nan, "cmp_pred_j45": pred.J45 if math.isfinite(j45) else nan,
            "cmp_ref_sph": ref.sph, "cmp_ref_cyl": ref.cyl, "cmp_ref_axis": nan if ref.axis is None else ref.axis,
            "cmp_pred_sph": rx.sph if rx else nan, "cmp_pred_cyl": rx.cyl if rx else nan,
            "cmp_pred_axis": nan if rx is None or rx.axis is None else rx.axis}


def prepare(export: pd.DataFrame, reference: str = "autorefractor", model_version: Optional[str] = None,
            one_eye: bool = False, seed: int = 0) -> tuple[pd.DataFrame, dict[str, Any]]:
    """One row per eye per visit: its outcome, the reference chosen, and the values compared.

    Refuses an export that mixes simulated and real data, or results from several model versions
    without one chosen: the protocol freezes the model before the study starts. With ``one_eye``, keeps
    one eye per subject, chosen at random with ``seed``: the research protocol's primary analysis.
    """
    if reference != "best" and reference not in REFERENCE_PRIORITY:
        raise StudyError(f"reference must be 'best' or one of {', '.join(REFERENCE_PRIORITY)}, not {reference!r}")
    if export.empty:
        raise StudyError("the export has no eyes")
    df = export.copy()
    for col in ("output_level", "model_version", "predicted_at", *(g for g in SUBGROUPS if g not in BANDS), *NUMERIC):
        if col not in df:
            df[col] = None  # a column no row had
    for col in NUMERIC:
        df[col] = pd.to_numeric(df[col], errors="coerce").astype(float)
    df["simulated"] = df["simulated"].map(_bool)
    if df["simulated"].nunique() > 1:
        raise StudyError("the export mixes simulated and real data; analyse them separately")

    has_result = df["output_level"].notna()
    versions = sorted(str(v) for v in df.loc[has_result, "model_version"].dropna().unique())
    left_out = 0
    if model_version is not None:
        if model_version not in versions:
            raise StudyError(f"no results from model version {model_version!r}; the export has {versions or 'none'}")
        eye = df["session_id"].astype(str) + "/" + df["eye"].astype(str)
        chosen = has_result & (df["model_version"].astype(str) == model_version)
        left_out = int(eye[has_result & ~eye.isin(eye[chosen])].nunique())  # only other versions' results
        df = df[chosen | ~has_result]
        versions = [model_version]
    elif len(versions) > 1:
        raise StudyError(f"results from {len(versions)} model versions ({', '.join(versions)}); the protocol "
                         "freezes one before the study, so choose it with model_version")
    # a result stored twice for the same eye and visit counts once: the later one
    df = (df.sort_values("predicted_at", na_position="first", kind="stable")
            .drop_duplicates(["session_id", "eye"], keep="last").reset_index(drop=True))
    if one_eye:
        rng = np.random.default_rng(seed)
        eyes_of = df.groupby(df["subject_id"].astype(str))["eye"].unique()
        chosen_eye = {s: str(rng.choice(sorted(e))) for s, e in eyes_of.items()}
        df = df[df["eye"] == df["subject_id"].astype(str).map(chosen_eye)].reset_index(drop=True)

    methods = REFERENCE_PRIORITY if reference == "best" else (reference,)
    refs = pd.DataFrame([_reference(r, methods) for _, r in df.iterrows()], index=df.index)
    df = df.join(refs)
    df["outcome"] = [_outcome(r) for _, r in df.iterrows()]
    df["screened"] = df["outcome"].isin(SCREENED)
    limits = [thresholds_for_age(a) for a in df["age_group"].fillna("unknown")]
    df["myopia_from"] = [t.myopia_se for t in limits]
    df["hyperopia_from"] = [t.hyperopia_se for t in limits]
    df["astigmatism_from"] = [t.astigmatism_cyl for t in limits]
    df["visit_day"] = pd.to_datetime(df["session_started_at"], utc=True, format="ISO8601").dt.strftime("%Y-%m-%d")
    df["ref_se"] = df["ref_sph"] + df["ref_cyl"] / 2
    for band, (col, edges, labels) in BANDS.items():
        df[band] = pd.cut(df[col], edges, labels=labels).astype(object)
    compare = df["ref_method"].notna() & (df["outcome"] == "quantitative") & df["pred_se"].notna()
    cmp = pd.DataFrame([_compared(r) for _, r in df[compare].iterrows()], index=df.index[compare])
    for col in ("m", "j0", "j45", "sph", "cyl", "axis"):
        for side in ("ref", "pred"):
            df[f"cmp_{side}_{col}"] = cmp[f"cmp_{side}_{col}"] if len(cmp) else np.nan
    df["corneal_plane"] = cmp["corneal_plane"].reindex(df.index, fill_value=False) if "corneal_plane" in cmp else False
    info = {"simulated": bool(df["simulated"].iloc[0]), "reference": reference, "model_versions": versions,
            "eyes_per_subject": f"one, chosen at random (seed {seed})" if one_eye else "both",
            "eyes_left_out_other_model_versions": left_out}
    return df, info


def repeatability(values: Sequence[float], groups: Sequence[Hashable]) -> dict[str, float]:
    """Test-retest repeatability of measurements, each group one eye measured more than once.

    One-way random-effects ICC(1,1) for unequal group sizes, the within-subject SD Sw (root of the
    within-group mean square) and the coefficient of repeatability 2.77 Sw, within which 95% of repeat
    differences fall (Bland and Altman 1996).
    """
    df = pd.DataFrame({"y": pd.to_numeric(pd.Series(values), errors="coerce"), "g": list(groups)}).dropna()
    df = df[df.groupby("g")["y"].transform("size") >= 2]
    k, n = df["g"].nunique(), len(df)
    out: dict[str, float] = {"n_eyes": k, "n_measurements": n}
    if k < 2:
        return out
    by = df.groupby("g")["y"].agg(["size", "mean"])
    msw = float(((df["y"] - df.groupby("g")["y"].transform("mean")) ** 2).sum() / (n - k))
    msb = float((by["size"] * (by["mean"] - df["y"].mean()) ** 2).sum() / (k - 1))
    n0 = (n - float((by["size"] ** 2).sum()) / n) / (k - 1)
    sw = math.sqrt(msw)
    out.update({"icc": (msb - msw) / (msb + (n0 - 1) * msw) if msb + (n0 - 1) * msw > 0 else math.nan,
                "sw": sw, "cor": COR_PER_SW * sw})
    return out


def _auc(truth: np.ndarray, score: np.ndarray) -> float:
    """Area under the ROC curve: the chance a case scores above a non-case, ties counting half."""
    n1 = int(truth.sum())
    n0 = truth.size - n1
    if not (n1 and n0):
        return math.nan
    ranks = rankdata(score)
    return float((ranks[truth].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def _scores(p: np.ndarray, screened: np.ndarray) -> np.ndarray:
    """Every eye counts: one that could not be screened, or was given no probability, is referred and scores
    1 for the ROC."""
    return np.where(screened & np.isfinite(p), p, 1.0)


def _screens(eyes: pd.DataFrame) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray, float]]:
    """Each screening question: the reference's answer, the product's probability, whether the eye was
    screened, and the probability the product refers at. Per eye with a reference; for anisometropia, per
    visit with a reference for both eyes."""
    ref = eyes[eyes["ref_se"].notna()]
    se, screened = ref["ref_se"].to_numpy(float), ref["screened"].to_numpy(bool)
    cyl = ref["ref_cyl"].abs().to_numpy(float)

    def p(col: str) -> np.ndarray:
        return ref[col].to_numpy(float)

    out = {"myopia_0_50": (se <= -0.5, p("p_myopia"), screened, 0.5),
           "myopia_1_00": (se <= -1.0, p("p_myopia"), screened, 0.5),
           "hyperopia": (se >= p("hyperopia_from"), p("p_hyperopia"), screened, 0.5),
           "astigmatism": (cyl >= p("astigmatism_from"), p("p_astigmatism"), screened, ASTIGMATISM_REFERRAL)}
    od = ref[ref["eye"] == "OD"].set_index("session_id")
    os_ = ref[ref["eye"] == "OS"].set_index("session_id")
    both = od.index.intersection(os_.index)
    if len(both):
        a, b = od.loc[both], os_.loc[both]
        out["anisometropia"] = (((a["ref_se"] - b["ref_se"]).abs() >= 1.0).to_numpy(),
                                np.fmax(a["p_anisometropia"].to_numpy(float), b["p_anisometropia"].to_numpy(float)),
                                (a["screened"] & b["screened"]).to_numpy(bool), 0.5)
    return out


def cross_table(truth: np.ndarray, p: np.ndarray, screened: np.ndarray, threshold: float) -> dict[str, int]:
    """The 2x2 table of referral against the reference (STARD 2015), and how many of the referred were
    referred because the product could not screen them."""
    refer, y = _scores(p, screened) >= threshold, truth.astype(bool)
    return {"true_positive": int((refer & y).sum()), "false_positive": int((refer & ~y).sum()),
            "false_negative": int((~refer & y).sum()), "true_negative": int((~refer & ~y).sum()),
            "not_screened": int((~(screened & np.isfinite(p))).sum())}


def roc_curve(truth: np.ndarray, score: np.ndarray) -> list[dict[str, float]]:
    """Sensitivity and specificity when referring at each score an eye was given, highest first."""
    y = truth.astype(bool)
    if y.all() or not y.any():
        return []
    return [{"refer_from": float(t), "sensitivity": float((score[y] >= t).mean()),
             "specificity": float((score[~y] < t).mean())} for t in np.unique(score)[::-1]]


def _screening(truth: np.ndarray, p: np.ndarray, screened: np.ndarray, threshold: float = 0.5) -> dict[str, float]:
    if truth.size == 0:
        return {}
    t = cross_table(truth, p, screened, threshold)
    tp, fp, fn, tn = t["true_positive"], t["false_positive"], t["false_negative"], t["true_negative"]

    def div(a: int, b: int) -> float:
        return a / b if b else math.nan

    y = truth.astype(bool)
    return {"prevalence": float(y.mean()), "sensitivity": div(tp, tp + fn), "specificity": div(tn, tn + fp),
            "ppv": div(tp, tp + fp), "npv": div(tn, tn + fn), "auc": _auc(y, _scores(p, screened))}


def _agreement(pred: pd.Series | np.ndarray, ref: pd.Series | np.ndarray) -> dict[str, float]:
    p, t = np.asarray(pred, float), np.asarray(ref, float)
    ok = np.isfinite(p) & np.isfinite(t)
    p, t = p[ok], t[ok]
    if p.size < 3:
        return {}
    d, mean = p - t, (p + t) / 2
    m = dioptric_metrics(p, t)
    sd = float(d.std(ddof=1))
    m.pop("n")
    return {**m, "sd_diff": sd, "loa_low": float(d.mean() - 1.96 * sd), "loa_high": float(d.mean() + 1.96 * sd),
            "proportional_bias_slope": float(np.polyfit(mean, d, 1)[0]) if np.ptp(mean) > 0 else math.nan}


def _repeats(eyes: pd.DataFrame) -> dict[str, float]:
    """Released SEs of the same eye on the same day, from separate visits."""
    q = eyes[eyes["outcome"] == "quantitative"]
    return repeatability(q["pred_se"], q["subject_id"].astype(str) + "/" + q["eye"].astype(str) + "/" + q["visit_day"])


def study_metrics(eyes: pd.DataFrame) -> dict[str, float]:
    """Every statistic of the report, flat ("agreement/se/bias"), as bootstrapped over subjects."""
    out: dict[str, float] = {}
    for o in OUTCOMES:
        out[f"outcomes/{o}"] = float((eyes["outcome"] == o).mean())

    quant = eyes[eyes["cmp_pred_m"].notna()]
    for name in ("m", "j0", "j45", "sph", "cyl"):
        stats = _agreement(quant[f"cmp_pred_{name}"], quant[f"cmp_ref_{name}"])
        out.update({f"agreement/{'se' if name == 'm' else name}/{k}": v for k, v in stats.items()})
    released = quant[quant["cmp_pred_axis"].notna()]
    axis = axis_metrics(released["cmp_pred_axis"].tolist(), released["cmp_ref_axis"].tolist(),
                        released["cmp_ref_cyl"].tolist())
    out.update({f"agreement/axis/{k}": v for k, v in axis.items() if k != "n"})
    ci = quant[quant["pred_se_ci_low"].notna()]
    if len(ci):
        inside = (ci["ref_se"] >= ci["pred_se_ci_low"]) & (ci["ref_se"] <= ci["pred_se_ci_high"])
        out["agreement/se_ci95/coverage"] = float(inside.mean())
        out["agreement/se_ci95/mean_width"] = float((ci["pred_se_ci_high"] - ci["pred_se_ci_low"]).mean())

    for name, (truth, p, screened, refer_at) in _screens(eyes).items():
        out.update({f"screening/{name}/{k}": v for k, v in _screening(truth, p, screened, refer_at).items()})
    for name, (truth, p) in _probabilities(eyes).items():
        table = calibration(truth, p)
        if table:
            out[f"calibration/{name}/ece"] = sum(b["eyes"] * abs(b["predicted"] - b["observed"]) for b in table) / sum(
                b["eyes"] for b in table)

    out.update({f"repeatability/{k}": v for k, v in _repeats(eyes).items() if not k.startswith("n_")})

    released = (eyes["outcome"] == "quantitative").to_numpy()
    pred_m, ref_m = eyes["cmp_pred_m"].to_numpy(float), eyes["cmp_ref_m"].to_numpy(float)
    for col in SUBGROUPS:
        values = eyes[col].to_numpy(object)
        present = set(eyes[col].dropna().unique())
        # bands in their own order, other groups alphabetically: the report keeps this order
        for value in [b for b in BANDS[col][2] if b in present] if col in BANDS else sorted(present, key=str):
            g = values == value
            stats = _agreement(pred_m[g], ref_m[g])
            out[f"subgroups/{col}/{value}/released"] = float(released[g].mean())
            out.update({f"subgroups/{col}/{value}/{k}": stats[k] for k in ("bias", "loa_low", "loa_high", "mae")
                        if k in stats})
    return {k: float(v) for k, v in out.items()}


def study_counts(eyes: pd.DataFrame) -> dict[str, Any]:
    rep = _repeats(eyes)
    return {
        "subjects": int(eyes["subject_id"].nunique()), "visits": int(eyes["session_id"].nunique()),
        "eyes": len(eyes), **{o: int((eyes["outcome"] == o).sum()) for o in OUTCOMES},
        "eyes_with_reference": int(eyes["ref_se"].notna().sum()), "eyes_compared": int(eyes["cmp_pred_m"].notna().sum()),
        "eyes_compared_at_cornea": int(eyes["corneal_plane"].astype(bool).sum()),
        "repeatability_eyes": int(rep["n_eyes"]), "repeatability_measurements": int(rep["n_measurements"]),
        "screening_tables": {name: cross_table(*screen) for name, screen in _screens(eyes).items()},
        "subgroups": {col: {str(k): int(v) for k, v in eyes[col].value_counts().items()} for col in SUBGROUPS},
    }


def _probabilities(eyes: pd.DataFrame) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Each class probability the product gave, against the reference's class at the product's own age
    thresholds, over the screened eyes with a reference: what calibration is judged on."""
    s = eyes[eyes["screened"] & eyes["ref_se"].notna()]
    se, cyl = s["ref_se"].to_numpy(float), s["ref_cyl"].abs().to_numpy(float)
    return {"myopia": (se <= s["myopia_from"].to_numpy(float), s["p_myopia"].to_numpy(float)),
            "hyperopia": (se >= s["hyperopia_from"].to_numpy(float), s["p_hyperopia"].to_numpy(float)),
            "astigmatism": (cyl >= s["astigmatism_from"].to_numpy(float), s["p_astigmatism"].to_numpy(float))}


def calibration(truth: np.ndarray, p: np.ndarray, bins: int = 10) -> list[dict[str, float]]:
    """Reliability table: in each tenth of predicted probability, the mean prediction against the observed
    frequency. A well calibrated model sits on the diagonal."""
    ok = np.isfinite(p)
    truth, p = truth[ok].astype(bool), p[ok]
    which = np.minimum((p * bins).astype(int), bins - 1)
    return [{"from": b / bins, "to": (b + 1) / bins, "eyes": int((which == b).sum()),
             "predicted": float(p[which == b].mean()), "observed": float(truth[which == b].mean())}
            for b in range(bins) if (which == b).any()]


def subject_bootstrap(eyes: pd.DataFrame, statistic: Callable[[pd.DataFrame], dict[str, float]],
                      n_boot: int = 2000, seed: int = 0, level: float = 0.95) -> dict[str, tuple[float, float]]:
    """Percentile confidence intervals from resampling whole subjects with replacement.

    A subject drawn twice enters twice under two names, with their visits renamed too, so their
    eyes stay independent copies rather than merging into one subject.
    """
    rng = np.random.default_rng(seed)
    ids = eyes["subject_id"].astype(str).to_numpy()
    subjects = np.unique(ids)
    rows = [np.flatnonzero(ids == s) for s in subjects]
    draws: dict[str, list[float]] = defaultdict(list)
    for _ in range(n_boot):
        pick = rng.integers(0, subjects.size, subjects.size)
        idx = [rows[i] for i in pick]
        sample = eyes.iloc[np.concatenate(idx)].copy()
        copy = np.repeat(np.arange(pick.size), [i.size for i in idx]).astype(str)
        sample["subject_id"] = sample["subject_id"].astype(str).to_numpy() + "#" + copy
        sample["session_id"] = sample["session_id"].astype(str).to_numpy() + "#" + copy
        for k, v in statistic(sample).items():
            draws[k].append(v)
    q = (100 * (1 - level) / 2, 100 * (1 + level) / 2)
    out: dict[str, tuple[float, float]] = {}
    for k, v in draws.items():
        a = np.asarray(v, float)
        a = a[np.isfinite(a)]
        if a.size:
            lo, hi = np.percentile(a, q)
            out[k] = (float(lo), float(hi))
    return out


def _nest(point: dict[str, float], ci: dict[str, tuple[float, float]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in point.items():
        *path, leaf = key.split("/")
        node = out
        for p in path:
            node = node.setdefault(p, {})
        node[leaf] = {"value": value if math.isfinite(value) else None,
                      "ci95": list(ci[key]) if key in ci and math.isfinite(value) else None}
    return out


def study_report(export: pd.DataFrame, reference: str = "autorefractor", model_version: Optional[str] = None,
                 n_boot: int = 2000, seed: int = 0, one_eye: bool = False) -> dict[str, Any]:
    eyes, info = prepare(export, reference, model_version, one_eye, seed)
    point = study_metrics(eyes)
    ci = subject_bootstrap(eyes, study_metrics, n_boot, seed) if n_boot else {}
    compared = eyes[eyes["cmp_pred_m"].notna()]
    differences = sorted(((p + r) / 2, p - r) for p, r in zip(compared["cmp_pred_m"], compared["cmp_ref_m"], strict=True))
    return {
        "kind": REPORT_KIND, "format_version": REPORT_FORMAT,
        **({"label": "SIMULATED DATA: not evidence about real eyes"} if info["simulated"] else {}),
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"), "eyeref_ml_version": __version__,
        **info,
        "n": study_counts(eyes),
        "bootstrap": {"replicates": n_boot, "seed": seed, "resampled": "subjects", "interval": "95% percentile"},
        "metrics": _nest(point, ci),
        "roc_curves": {name: roc_curve(truth, _scores(p, screened))
                       for name, (truth, p, screened, _) in _screens(eyes).items()},
        "calibration_tables": {name: calibration(truth, p) for name, (truth, p) in _probabilities(eyes).items()},
        # each eye given a number, as compared (released minus reference), in order of the mean
        "bland_altman_se": [{"mean": round(m, 3), "diff": round(d, 3)} for m, d in differences],
    }


def _fmt(m: dict[str, Any] | None, unit: str = "", pct: bool = False, signed: bool = False) -> str:
    if not m or m.get("value") is None:
        return "n/a"

    def f(v: float) -> str:
        v = round(v, 2) + 0.0  # no "-0.00"
        return f"{100 * v:.0f}%" if pct else f"{v:+.2f}" if signed else f"{v:.2f}"

    ci = f" [{f(m['ci95'][0])} to {f(m['ci95'][1])}]" if m.get("ci95") else ""
    return f"{f(m['value'])}{unit}{ci}"


def _count(k: int, noun: str) -> str:
    return f"{k} {noun}{'' if k == 1 else 's'}"


def summary(report: dict[str, Any]) -> str:
    m, n, boot = report["metrics"], report["n"], report["bootstrap"]
    se = m.get("agreement", {}).get("se", {})
    left_out = report["eyes_left_out_other_model_versions"]
    lines = [
        *([report["label"]] if "label" in report else []),
        f"Model {', '.join(report['model_versions']) or 'none'}, reference {report['reference']}, eyes per subject "
        f"{report['eyes_per_subject']}: {n['subjects']} subjects, {n['visits']} visits, {n['eyes']} eyes"
        + (f" ({left_out} more with results from other model versions only, left out)" if left_out else "") + ".",
        *([f"95% confidence intervals in brackets, from {boot['replicates']} resamples of subjects."]
          if boot["replicates"] else []),
        "Outcomes: " + ", ".join(f"{o.replace('_', ' ')} {n[o]} ({_fmt(m['outcomes'][o], pct=True)})" for o in OUTCOMES),
        f"SE agreement over {n['eyes_compared']} eyes given a number, {n['eyes_compared_at_cornea']} of them compared at "
        f"the cornea: bias {_fmt(se.get('bias'), ' D', signed=True)}, 95% limits of agreement "
        f"{_fmt(se.get('loa_low'), ' D', signed=True)} and {_fmt(se.get('loa_high'), ' D', signed=True)}, "
        f"MAE {_fmt(se.get('mae'), ' D')}",
    ]
    for name, title in (("myopia_0_50", "Myopia (SE -0.50 D or less)"), ("myopia_1_00", "Myopia (SE -1.00 D or less)"),
                        ("hyperopia", "Hyperopia"), ("astigmatism", "Astigmatism"),
                        ("anisometropia", "Anisometropia (1.00 D or more)")):
        s, t = m.get("screening", {}).get(name), n["screening_tables"].get(name)
        if s and t:
            cases = t["true_positive"] + t["false_negative"]
            total = cases + t["false_positive"] + t["true_negative"]
            lines.append(f"{title}: {cases} of {_count(total, 'visit' if name == 'anisometropia' else 'eye')} with it, "
                         f"{t['not_screened']} referred unscreened; sensitivity {_fmt(s.get('sensitivity'), pct=True)}, "
                         f"specificity {_fmt(s.get('specificity'), pct=True)}, AUC {_fmt(s.get('auc'))}")
    r = m.get("repeatability", {})
    if r:
        lines.append(f"Repeatability over {_count(n['repeatability_eyes'], 'eye')}: ICC {_fmt(r.get('icc'))}, "
                     f"Sw {_fmt(r.get('sw'), ' D')}, coefficient of repeatability {_fmt(r.get('cor'), ' D')}")
    cal = m.get("calibration", {})
    if cal:
        lines.append("Calibration of the class probabilities, expected calibration error: " + ", ".join(
            f"{name} {_fmt(c.get('ece'))}" for name, c in cal.items()))
    for col, title in (("device_id", "device"), ("age_group", "age group"), ("refractive_range", "refractive range (D)"),
                       ("pupil_band", "pupil"), ("distance_band", "distance"), ("iris_color", "iris colour"),
                       ("pigmentation", "pigmentation"), ("sex", "sex")):
        for value, s in m.get("subgroups", {}).get(col, {}).items():
            lines.append(f"By {title}, {value}: {_count(n['subgroups'][col].get(value, 0), 'eye')}, released "
                         f"{_fmt(s.get('released'), pct=True)}, SE bias {_fmt(s.get('bias'), ' D', signed=True)}")
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", help="eye-level export, CSV or JSON (GET /api/dataset/export?level=eye)")
    ap.add_argument("--reference", default="autorefractor",
                    help=f"reference method: best (in the order {', '.join(REFERENCE_PRIORITY)}) or one of them")
    ap.add_argument("--model-version", help="the study's frozen model version, when the export has several")
    ap.add_argument("--one-eye", action="store_true",
                    help="one randomly chosen eye per subject (the primary analysis); both eyes otherwise")
    ap.add_argument("--boot", type=int, default=2000, help="bootstrap replicates (0: no intervals)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", help="write the full report here as JSON")
    a = ap.parse_args(argv)
    try:
        report = study_report(load_export(a.export), a.reference, a.model_version, a.boot, a.seed, a.one_eye)
    except (OSError, StudyError) as e:  # an unreadable file, or data that cannot be one study
        print(f"error: {e}", file=sys.stderr)
        return 2
    if a.out:
        Path(a.out).write_text(json.dumps(report, indent=2, allow_nan=False))  # strict JSON, for the web app
    print(summary(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
