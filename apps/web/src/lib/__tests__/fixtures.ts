import { extractFeatures } from "../cv/features";
import { meridianEyeDeg } from "../devices";
import { renderEye } from "../simulation/renderer";
import { SIM_DEVICE } from "../simulation/session";
import type { CaptureMetadata, FrameRecord, PhotorefractionFeatures, QualityGrade } from "../types";

/** Shared test fixtures: capture metadata and frames with a fixed meridional estimate. */
export const meta = (o: Partial<CaptureMetadata> = {}): CaptureMetadata => ({
  eye: "OD",
  timestamp: "2026-10-04T00:00:00Z",
  workingDistanceM: 1,
  distanceSource: "simulated",
  distanceSdM: 0.05,
  deviceRotationDeg: 0,
  headPose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
  illumination: "flash",
  sourceAngleImageDeg: null,
  eccentricityMm: null,
  mirrored: false,
  ageGroup: "adult_40_59",
  frameIndex: 0,
  simulated: true,
  motionPxPerFrame: 0.5,
  ...o,
});
export const IRIS = { cx: 79.5, cy: 79.5, r: 52 };

// one rendered eye's features serve every fixture frame: rendering it per frame made tests slow
let features: PhotorefractionFeatures | undefined;
const sharedFeatures = () => (features ??= extractFeatures(renderEye({ seed: 1 }).image, 270, IRIS).features);

/** A frame whose estimator saw `power` D in the meridian at device rotation `rot` (null: dead zone). */
export function frame(
  eye: "OD" | "OS",
  rot: number,
  power: number | null,
  grade: QualityGrade = "excellent",
  simulated = true,
): FrameRecord {
  const m = meta({ eye, deviceRotationDeg: rot, simulated });
  return {
    metadata: m,
    features: { ...sharedFeatures() },
    quality: {
      score: grade === "excellent" ? 0.9 : 0.1,
      grade,
      subscores: {} as never,
      hardFailures: [],
      advisories: [],
    },
    estimate: {
      meridianDeg: meridianEyeDeg(m, SIM_DEVICE),
      status: power === null ? "interval" : "quantitative",
      powerD: power,
      sigmaD: 0.2,
      intervalD: power === null ? [-2.3, 0.3] : null,
      estimator: "t",
      estimatorVersion: "0",
      notes: [],
    },
  };
}
