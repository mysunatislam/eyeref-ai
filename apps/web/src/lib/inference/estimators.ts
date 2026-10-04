/**
 * PhotorefractionEstimator implementations (twin of backend/eyeref/inference/estimators.py).
 *
 * estimate(features, metadata, device) -> MeridionalEstimate for ONE meridian.
 *  - PhysicsHeuristicEstimator: crescent-width inversion (+ calibrated dead-zone gradient).
 *  - SimulationOracleEstimator: simulator truth + noise; refuses non-simulated frames.
 *  - MlEstimatorUnavailable: placeholder for the ONNX model. It NEVER guesses: until a model
 *    trained on real data is loaded it returns "insufficient".
 */
import { effectiveEccentricity, meridianEyeDeg } from "../devices";
import {
  deadZoneInterval,
  invertWithUncertainty,
  validateGeometry,
  type Side,
} from "../optics/photorefraction";
import { createRng, normal } from "../random";
import type { CaptureMetadata, DeviceProfile, MeridionalEstimate, PhotorefractionFeatures } from "../types";

export interface PhotorefractionEstimator {
  readonly name: string;
  readonly version: string;
  readonly kind: "physics-heuristic" | "simulation" | "ml";
  estimate(
    features: PhotorefractionFeatures,
    meta: CaptureMetadata,
    device: DeviceProfile,
  ): MeridionalEstimate;
}

function insufficient(e: PhotorefractionEstimator, meridian: number | null, why: string): MeridionalEstimate {
  return {
    meridianDeg: meridian,
    status: "insufficient",
    powerD: null,
    sigmaD: null,
    intervalD: null,
    estimator: e.name,
    estimatorVersion: e.version,
    notes: [why],
  };
}

export class PhysicsHeuristicEstimator implements PhotorefractionEstimator {
  readonly name = "physics-crescent-inversion";
  readonly version = "1.0.0";
  readonly kind = "physics-heuristic" as const;

  constructor(
    private readonly widthRelSd = 0.08,
    private readonly pupilRelSd = 0.06,
    private readonly eccSdMm = 0.5,
  ) {}

  estimate(f: PhotorefractionFeatures, meta: CaptureMetadata, device: DeviceProfile): MeridionalEstimate {
    const meridian = meridianEyeDeg(meta, device);
    if (meta.illumination === "none")
      return insufficient(this, meridian, "No eccentric illumination: photorefraction impossible.");
    const ecc = effectiveEccentricity(meta, device);
    if (ecc === null || meridian === null)
      return insufficient(
        this,
        meridian,
        "Light-source geometry unknown for this device; run the Calibration Wizard.",
      );
    if (!f.pupilDiameterMm) return insufficient(this, meridian, "Pupil not measured.");
    const g = {
      workingDistanceM: meta.workingDistanceM,
      eccentricityM: ecc / 1000,
      pupilDiameterM: f.pupilDiameterMm / 1000,
    };
    const err = validateGeometry(g);
    if (err) return insufficient(this, meridian, `Geometry invalid: ${err}`);
    if (f.crescentPresent) {
      const w = f.crescentWidthNorm * g.pupilDiameterM;
      const res = invertWithUncertainty(w, f.crescentSide as Side, g, {
        widthM: Math.max(this.widthRelSd * w, 0.04 * g.pupilDiameterM),
        pupilM: this.pupilRelSd * g.pupilDiameterM,
        distanceM: meta.distanceSdM,
        eccentricityM: this.eccSdMm / 1000,
      });
      if (!res) return insufficient(this, meridian, "Crescent inversion failed.");
      const notes = ["Crescent-width inversion (Bobier-Braddick model)."];
      if (res.saturated) notes.push("Crescent fills most of the pupil: magnitude beyond measurable range.");
      return {
        meridianDeg: meridian,
        status: "quantitative",
        powerD: res.refractionD,
        sigmaD: res.sigmaD,
        intervalD: null,
        estimator: this.name,
        estimatorVersion: this.version,
        notes,
      };
    }
    const [lo, hi] = deadZoneInterval(g);
    if (device.gradientGain !== null) {
      const centre = (lo + hi) / 2;
      const half = (hi - lo) / 2;
      const p = Math.min(hi, Math.max(lo, centre - device.gradientGain * f.gradientAlongSource * half));
      return {
        meridianDeg: meridian,
        status: "quantitative",
        powerD: p,
        sigmaD: Math.max(half * device.gradientRelSd, 0.25),
        intervalD: [lo, hi],
        estimator: this.name,
        estimatorVersion: this.version,
        notes: ["No crescent: dead-zone value from device-calibrated brightness gradient."],
      };
    }
    return {
      meridianDeg: meridian,
      status: "interval",
      powerD: null,
      sigmaD: null,
      intervalD: [lo, hi],
      estimator: this.name,
      estimatorVersion: this.version,
      notes: [
        `No crescent: refraction in this meridian lies in the dead zone ${lo.toFixed(2)} to ${hi.toFixed(2)} D.`,
      ],
    };
  }
}

export class SimulationOracleEstimator implements PhotorefractionEstimator {
  readonly name = "simulation-oracle";
  readonly version = "1.0.0";
  readonly kind = "simulation" as const;
  private readonly rng;

  constructor(
    private readonly truthByFrame: Map<number, number>,
    private readonly noiseSd = 0.3,
    seed = 0,
  ) {
    this.rng = createRng(seed);
  }

  estimate(_f: PhotorefractionFeatures, meta: CaptureMetadata, device: DeviceProfile): MeridionalEstimate {
    if (!meta.simulated) throw new Error("SimulationOracleEstimator refuses non-simulated frames");
    const meridian = meridianEyeDeg(meta, device);
    const t = this.truthByFrame.get(meta.frameIndex);
    if (t === undefined) return insufficient(this, meridian, "No simulator truth for frame.");
    return {
      meridianDeg: meridian,
      status: "quantitative",
      powerD: t + normal(this.rng, 0, this.noiseSd),
      sigmaD: this.noiseSd,
      intervalD: null,
      estimator: this.name,
      estimatorVersion: this.version,
      notes: ["SIMULATED: oracle value + noise."],
    };
  }
}

export class MlEstimatorUnavailable implements PhotorefractionEstimator {
  readonly name = "onnx-meridional";
  readonly version = "unavailable";
  readonly kind = "ml" as const;

  estimate(_f: PhotorefractionFeatures, meta: CaptureMetadata, device: DeviceProfile): MeridionalEstimate {
    return insufficient(
      this,
      meridianEyeDeg(meta, device),
      "Learned model REQUIRES TRAINING DATA: no model trained on real clinical data is available. (The models in ml/artifacts were trained on simulated data and are refused for real eyes.)",
    );
  }
}
