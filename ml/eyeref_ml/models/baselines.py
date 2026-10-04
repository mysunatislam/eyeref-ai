"""Classical per-meridian estimators (the baseline any deep model must beat).

Every model maps one frame's interpretable features + metadata to the
refractive power along the probed meridian (mean and SD).  Eye-level
M/J0/J45 -> SPH/CYL/AXIS always goes through the SAME physics-based fusion
(eyeref.inference.fusion), so comparisons isolate the estimator.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np
import pandas as pd
from eyeref.inference.ml_features import INPUT_COLUMNS, model_inputs
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import PolynomialFeatures, StandardScaler

from .. import __version__  # noqa: F401
from ..evaluation.conformal import conformal_quantile


def add_physics_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Add the exact runtime model inputs (physics prior, dead-zone geometry)."""
    feat_cols = [c for c in df.columns if c.startswith("f_")]
    rows = [
        model_inputs({c[2:]: r[c] for c in feat_cols}, r["working_distance_m"], r["eccentricity_mm"])
        for _, r in df.iterrows()
    ]
    extra = pd.DataFrame(rows, index=df.index)
    out = df.copy()
    for c in extra.columns:
        out[c] = extra[c]
    return out


def design_matrix(df: pd.DataFrame) -> np.ndarray:
    return np.nan_to_num(df[INPUT_COLUMNS].astype(float).to_numpy(), nan=0.0)


class FrameModel(Protocol):
    name: str

    def fit(self, train: pd.DataFrame, calib: pd.DataFrame) -> FrameModel: ...
    def predict(self, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]: ...


@dataclass
class _ConformalSigma:
    """Group-wise conformal SD: separate scale inside/outside the dead zone."""

    q: dict[int, float] = field(default_factory=dict)

    def fit(self, resid: np.ndarray, groups: np.ndarray) -> None:
        for g in (0, 1):
            r = resid[groups == g]
            self.q[g] = conformal_quantile(r) / 1.96 if r.size >= 10 else float(np.std(resid) or 1.0)

    def __call__(self, groups: np.ndarray) -> np.ndarray:
        return np.array([self.q.get(int(g), max(self.q.values(), default=1.0)) for g in groups])


class PhysicsOnly:
    """No learning: the crescent inversion (dead zone -> centre)."""

    name = "physics_only"

    def __init__(self) -> None:
        self.sig = _ConformalSigma()

    def fit(self, train: pd.DataFrame, calib: pd.DataFrame) -> PhysicsOnly:
        r = (calib.phys_power - calib.gt_power_meridian).abs().to_numpy()
        self.sig.fit(np.nan_to_num(r, nan=5.0), calib.phys_in_dead_zone.to_numpy())
        return self

    def predict(self, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        return df.phys_power.to_numpy(), self.sig(df.phys_in_dead_zone.to_numpy())


class SklearnFrameModel:
    def __init__(self, name: str, estimator) -> None:
        self.name = name
        self.est = estimator
        self.sig = _ConformalSigma()

    def fit(self, train: pd.DataFrame, calib: pd.DataFrame) -> SklearnFrameModel:
        self.est.fit(design_matrix(train), train.gt_power_meridian.to_numpy())
        r = np.abs(self.est.predict(design_matrix(calib)) - calib.gt_power_meridian.to_numpy())
        self.sig.fit(r, calib.phys_in_dead_zone.to_numpy())
        return self

    def predict(self, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        return self.est.predict(design_matrix(df)), self.sig(df.phys_in_dead_zone.to_numpy())


def baseline_models(seed: int = 0) -> list[FrameModel]:
    return [
        PhysicsOnly(),
        SklearnFrameModel("ridge", make_pipeline(StandardScaler(), Ridge(alpha=1.0))),
        SklearnFrameModel("poly2_ridge", make_pipeline(StandardScaler(), PolynomialFeatures(2), Ridge(alpha=10.0))),
        SklearnFrameModel("random_forest", RandomForestRegressor(n_estimators=200, min_samples_leaf=3, n_jobs=-1, random_state=seed)),
        SklearnFrameModel("gradient_boosting", HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, random_state=seed)),
    ]
