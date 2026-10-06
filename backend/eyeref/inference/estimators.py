"""PhotorefractionEstimator implementations.

All estimators share one interface::

    estimate(features, metadata, device) -> MeridionalEstimate

and return the refractive power along ONE meridian (or an interval, or
"insufficient").  Combining meridians into SPH/CYL/AXIS happens in
:mod:`eyeref.inference.fusion`, so swapping the estimator never changes the
optics.

Implementations
---------------
PhysicsHeuristicEstimator  crescent-width inversion of the eccentric
                           photorefraction model (WORKING on synthetic data,
                           REQUIRES CLINICAL VALIDATION on real eyes).
SimulationOracleEstimator  only valid for SIMULATED frames: returns the
                           simulator's ground truth plus modelled noise, used to
                           demonstrate UI/analytics.  Refuses real frames.
OnnxMeridionalEstimator    learned model (REQUIRES TRAINING DATA); loads an ONNX
                           file exported by ml/eyeref_ml/export.  If the file is
                           missing it reports "insufficient" - never a guess.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Optional, Protocol

import numpy as np

from ..optics.photorefraction import (
    EccentricGeometry,
    dead_zone_interval,
    invert_with_uncertainty,
)
from ..types import CaptureMetadata, DeviceProfile, MeridionalEstimate, PhotorefractionFeatures
from .ml_features import model_inputs


class PhotorefractionEstimator(Protocol):
    name: str
    version: str
    kind: str

    def estimate(
        self, features: PhotorefractionFeatures, metadata: CaptureMetadata, device: DeviceProfile
    ) -> MeridionalEstimate: ...


def _insufficient(est: PhotorefractionEstimator, meridian: Optional[float], why: str) -> MeridionalEstimate:
    return MeridionalEstimate(
        meridian_deg=meridian, status="insufficient", estimator=est.name, estimator_version=est.version, notes=[why]
    )


class PhysicsHeuristicEstimator:
    name = "physics-crescent-inversion"
    version = "1.0.0"
    kind = "physics-heuristic"

    def __init__(self, width_rel_sd: float = 0.08, pupil_rel_sd: float = 0.06, ecc_sd_mm: float = 0.5):
        self.width_rel_sd = width_rel_sd
        self.pupil_rel_sd = pupil_rel_sd
        self.ecc_sd_mm = ecc_sd_mm

    def estimate(self, features: PhotorefractionFeatures, metadata: CaptureMetadata, device: DeviceProfile) -> MeridionalEstimate:
        meridian = metadata.meridian_eye_deg(device)
        if metadata.illumination == "none":
            return _insufficient(self, meridian, "No eccentric illumination: photorefraction impossible.")
        ecc_mm = metadata.effective_eccentricity_mm(device)
        if ecc_mm is None or meridian is None:
            return _insufficient(self, meridian, "Light-source geometry unknown for this device; run the calibration wizard.")
        if not features.pupil_diameter_mm:
            return _insufficient(self, meridian, "Pupil not measured.")
        g = EccentricGeometry(metadata.working_distance_m, ecc_mm / 1000.0, features.pupil_diameter_mm / 1000.0)
        try:
            g.validate()
        except ValueError as e:
            return _insufficient(self, meridian, f"Geometry invalid: {e}")

        if features.crescent_present:
            w_m = features.crescent_width_norm * g.pupil_diameter_m
            res = invert_with_uncertainty(
                w_m,
                features.crescent_side,  # type: ignore[arg-type]
                g,
                sigma_width_m=max(self.width_rel_sd * w_m, 0.04 * g.pupil_diameter_m),
                sigma_pupil_m=self.pupil_rel_sd * g.pupil_diameter_m,
                sigma_distance_m=metadata.distance_sd_m,
                sigma_eccentricity_m=self.ecc_sd_mm / 1000.0,
            )
            if res is None:
                return _insufficient(self, meridian, "Crescent inversion failed.")
            notes = ["Crescent-width inversion (Bobier-Braddick model)."]
            if res.saturated:
                notes.append("Crescent fills most of the pupil: magnitude beyond measurable range (high refractive error).")
            return MeridionalEstimate(
                meridian_deg=meridian, status="quantitative", power_d=res.refraction_d, sigma_d=res.sigma_d,
                estimator=self.name, estimator_version=self.version, notes=notes,
            )

        lo, hi = dead_zone_interval(g)
        if device.gradient_gain is not None:
            centre = 0.5 * (lo + hi)
            half = 0.5 * (hi - lo)
            # gain is expressed in dead-zone half-widths per unit normalised slope
            p = float(np.clip(centre - device.gradient_gain * features.gradient_along_source * half, lo, hi))
            return MeridionalEstimate(
                meridian_deg=meridian, status="quantitative", power_d=p, sigma_d=max(half * device.gradient_rel_sd, 0.25),
                interval_d=(lo, hi), estimator=self.name, estimator_version=self.version,
                notes=["No crescent: dead-zone value from device-calibrated brightness gradient."],
            )
        return MeridionalEstimate(
            meridian_deg=meridian, status="interval", interval_d=(lo, hi), estimator=self.name,
            estimator_version=self.version,
            notes=[f"No crescent: refraction in this meridian lies inside the dead zone {lo:+.2f} to {hi:+.2f} D "
                   "(gradient gain not calibrated for this device)."],
        )


class SimulationOracleEstimator:
    """Returns simulator truth + modelled noise.  NEVER used on real frames."""

    name = "simulation-oracle"
    version = "1.0.0"
    kind = "simulation"

    def __init__(self, truth_power_by_frame: dict[int, float], noise_sd: float = 0.3, seed: int = 0):
        self.truth = truth_power_by_frame
        self.noise_sd = noise_sd
        self.rng = np.random.default_rng(seed)

    def estimate(self, features: PhotorefractionFeatures, metadata: CaptureMetadata, device: DeviceProfile) -> MeridionalEstimate:
        meridian = metadata.meridian_eye_deg(device)
        if not metadata.simulated:
            raise PermissionError("SimulationOracleEstimator refuses non-simulated frames")
        if metadata.frame_index not in self.truth:
            return _insufficient(self, meridian, "No simulator truth for frame.")
        p = self.truth[metadata.frame_index] + float(self.rng.normal(0, self.noise_sd))
        return MeridionalEstimate(
            meridian_deg=meridian, status="quantitative", power_d=p, sigma_d=self.noise_sd,
            estimator=self.name, estimator_version=self.version, notes=["SIMULATED: oracle value + noise."],
        )


class OnnxMeridionalEstimator:
    """Learned per-meridian estimator exported by the training pipeline.

    Expects ``<model>.onnx`` plus ``<model>.json`` with the ordered feature
    names, normalisation statistics and version metadata.
    """

    kind = "ml"

    def __init__(self, model_path: str | Path):
        self.model_path = Path(model_path)
        self.meta_path = self.model_path.with_suffix(".json")
        self.session = None
        self.meta: dict = {}
        self.name = "onnx-meridional"
        self.version = "unavailable"
        if self.model_path.exists() and self.meta_path.exists():
            import onnxruntime as ort  # optional dependency

            self.session = ort.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
            self.meta = json.loads(self.meta_path.read_text())
            self.name = self.meta.get("model_name", self.name)
            self.version = self.meta.get("model_version", "0")

    @property
    def available(self) -> bool:
        return self.session is not None

    def _inputs(self, features: PhotorefractionFeatures, metadata: CaptureMetadata, device: DeviceProfile):
        row = model_inputs(features.numeric_vector(), metadata.working_distance_m, metadata.effective_eccentricity_mm(device))
        names: list[str] = self.meta["feature_names"]
        x = np.array([row[n] for n in names], np.float32)
        mu = np.array(self.meta["feature_mean"], np.float32)
        sd = np.array(self.meta["feature_std"], np.float32)
        return {"features": ((x - mu) / np.where(sd > 0, sd, 1.0))[None, :],
                "prior": np.array([[row["phys_power"]]], np.float32)}

    def estimate(self, features: PhotorefractionFeatures, metadata: CaptureMetadata, device: DeviceProfile) -> MeridionalEstimate:
        meridian = metadata.meridian_eye_deg(device)
        if not self.available:
            return _insufficient(self, meridian, f"Model file {self.model_path.name} not found: train and export a model first.")
        if self.meta.get("trained_on_simulated", False) and not metadata.simulated:
            return _insufficient(self, meridian, "Model was trained on SIMULATED data only; refusing to apply it to real eyes.")
        trained_on = self.meta.get("extractor_version")
        if trained_on and features.extractor_version != trained_on:
            return _insufficient(self, meridian, f"Model was trained on features from extractor {trained_on}, not "
                                                 f"{features.extractor_version}; retrain it on these features.")
        out = self.session.run(None, self._inputs(features, metadata, device))  # type: ignore[union-attr]
        mean, log_var = float(out[0][0][0]), float(out[1][0][0])
        sigma = math.sqrt(math.exp(log_var)) * float(self.meta.get("conformal_scale", 1.0))
        return MeridionalEstimate(
            meridian_deg=meridian, status="quantitative", power_d=mean, sigma_d=sigma,
            estimator=self.name, estimator_version=self.version, notes=["Learned heteroscedastic estimator."],
        )
