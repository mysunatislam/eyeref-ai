import { describe, expect, it } from "vitest";
import { extractFeatures } from "../cv/features";
import { assessQuality } from "../cv/quality";
import { meridianEyeDeg } from "../devices";
import {
  MlEstimatorUnavailable,
  PhysicsHeuristicEstimator,
  SimulationOracleEstimator,
} from "../inference/estimators";
import { buildReport, DEFAULT_GATING, fuseEye } from "../inference/fusion";
import { processFrame, unmirrorMetadata } from "../inference/pipeline";
import { circularAxisError } from "../optics/powerVector";
import { renderEye } from "../simulation/renderer";
import { makeSubject, SIM_DEVICE, simulateFrame } from "../simulation/session";
import { assignSides, headPoseFromMatrix, rollFromEyes } from "../tracking/eyeGeometry";
import type { CaptureMetadata, FrameRecord, QualityGrade } from "../types";

const meta = (o: Partial<CaptureMetadata> = {}): CaptureMetadata => ({
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
const IRIS = { cx: 79.5, cy: 79.5, r: 52 };

describe("on-device segmentation and features (synthetic)", () => {
  it("measures the pupil", () => {
    const { image, truth } = renderEye({ pupilDiameterMm: 6, seed: 1 });
    const { features } = extractFeatures(image, 270, IRIS);
    expect(features.pupil).not.toBeNull();
    expect(Math.abs(features.pupil!.r - truth.pupilRadiusPx) / truth.pupilRadiusPx).toBeLessThan(0.06);
  });
  it.each([
    [-4, 270],
    [-3, 0],
    [1, 45],
    [2, 270],
  ])("recovers crescent side and width for R=%d at %d°", (R, ang) => {
    const { image, truth } = renderEye({
      refraction: { sph: R, cyl: 0, axis: null },
      sourceAngleImageDeg: ang,
      seed: 4,
    });
    const { features } = extractFeatures(image, ang, IRIS);
    expect(features.crescentPresent).toBe(true);
    expect(features.crescentSide).toBe(truth.crescentSide);
    expect(
      Math.abs(features.crescentWidthNorm - truth.crescentWidthPx / (2 * truth.pupilRadiusPx)),
    ).toBeLessThan(0.06);
  });
  it("finds no crescent in the dead zone", () => {
    const { image } = renderEye({ refraction: { sph: -1, cyl: 0, axis: null }, seed: 5 });
    expect(extractFeatures(image, 270, IRIS).features.crescentPresent).toBe(false);
  });
});

describe("quality model", () => {
  const q = (params: Parameters<typeof renderEye>[0], m: Partial<CaptureMetadata> = {}) => {
    const { image } = renderEye(params);
    const { features, segmentation } = extractFeatures(image, 270, IRIS, m.illumination !== "none");
    return assessQuality(image, segmentation, features, meta(m));
  };
  it("accepts a clean frame", () => expect(["excellent", "acceptable"]).toContain(q({ seed: 7 }).grade));
  it("rejects a blink", () => expect(q({ eyelidOpening: 0.15, seed: 8 }).grade).toBe("reject"));
  it("rejects motion", () =>
    expect(q({ blurSigmaPx: 3.5, seed: 9 }, { motionPxPerFrame: 8 }).hardFailures).toContain("motion"));
  it("rejects small pupils", () =>
    expect(q({ pupilDiameterMm: 2.5, seed: 10 }).hardFailures).toContain("pupil_too_small"));
  it("rejects head rotation", () =>
    expect(q({ seed: 11 }, { headPose: { yawDeg: 30, pitchDeg: 0, rollDeg: 0 } }).hardFailures).toContain(
      "head_rotated",
    ));
  it("rejects an invalid (blank) image", () => {
    const blank = { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4) };
    const { features, segmentation } = extractFeatures(blank, 270, { cx: 50, cy: 50, r: 30 });
    expect(assessQuality(blank, segmentation, features, meta()).grade).toBe("reject");
  });
});

function frame(
  eye: "OD" | "OS",
  rot: number,
  power: number | null,
  grade: QualityGrade = "excellent",
  simulated = true,
): FrameRecord {
  const m = meta({ eye, deviceRotationDeg: rot, simulated });
  return {
    metadata: m,
    features: extractFeatures(renderEye({ seed: 1 }).image, 270, IRIS).features,
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

describe("fusion and gating", () => {
  it("never produces values from rejected frames", () => {
    const r = fuseEye(
      "OD",
      Array.from({ length: 10 }, () => frame("OD", 0, -3, "reject")),
      "adult_18_39",
      true,
    );
    expect(r.outputLevel).toBe("repeat");
    expect([r.seD, r.sphD, r.cylD, r.axisDeg]).toEqual([null, null, null, null]);
  });
  it("gives a quantitative SE with enough good frames", () => {
    const frames = [0, 45, 90, 135].flatMap((rot) => Array.from({ length: 5 }, () => frame("OD", rot, -3)));
    const r = fuseEye("OD", frames, "adult_40_59", true);
    expect(r.outputLevel).toBe("quantitative");
    expect(r.seD).toBeCloseTo(-3, 0);
    expect(r.refractiveClass).toBe("myopia");
  });
  it("keeps CYL/AXIS hidden unless enabled", () => {
    const r = fuseEye(
      "OD",
      [0, 45, 90, 135].flatMap((rot) => Array.from({ length: 5 }, () => frame("OD", rot, -3))),
      "adult_40_59",
      true,
    );
    expect(r.cylD).toBeNull();
    expect(r.axisDeg).toBeNull();
  });
  it("applies the confidence threshold", () => {
    const frames = Array.from({ length: 5 }, () => ({
      ...frame("OD", 0, -0.5),
      estimate: { ...frame("OD", 0, -0.5).estimate!, sigmaD: 0.9 },
    }));
    const r = fuseEye("OD", frames, "child_3_7", false, {
      ...DEFAULT_GATING,
      minClassConfidenceScreening: 0.99,
    });
    expect(r.outputLevel).toBe("repeat");
  });
  it("reports dead-zone-only results as screening", () => {
    const r = fuseEye(
      "OD",
      Array.from({ length: 5 }, () => frame("OD", 0, null)),
      "adult_18_39",
      true,
    );
    expect(r.outputLevel).toBe("screening");
    expect(r.deadZoneD).toEqual([-2.3, 0.3]);
  });
  it("separates eyes and detects anisometropia", () => {
    const frames = [
      ...[0, 90].flatMap((rot) => Array.from({ length: 5 }, () => frame("OD", rot, -4))),
      ...[0, 90].flatMap((rot) => Array.from({ length: 5 }, () => frame("OS", rot, -1))),
    ];
    const rep = buildReport({
      frames,
      ageGroup: "adult_60_plus",
      deviceId: "simulated-phone",
      calibrationVersion: "c",
      estimator: { name: "t", version: "0", kind: "test" },
      extractorVersion: "x",
    });
    expect(rep.eyes.OD.seD!).toBeCloseTo(-4, 0);
    expect(rep.eyes.OS.seD!).toBeCloseTo(-1, 0);
    expect(rep.anisometropiaProbability!).toBeGreaterThan(0.9);
    expect(rep.provenance.modelName).toBe("t");
    expect(rep.interpretation.startsWith("SIMULATED")).toBe(true);
  });
  it("refuses to mix simulated and real frames", () => {
    expect(() =>
      buildReport({
        frames: [frame("OD", 0, -1), frame("OD", 0, -1, "excellent", false)],
        ageGroup: "unknown",
        deviceId: "d",
        calibrationVersion: "c",
        estimator: { name: "t", version: "0", kind: "t" },
        extractorVersion: "x",
      }),
    ).toThrow();
  });
});

describe("estimators", () => {
  it("oracle refuses real frames; ML placeholder never guesses", () => {
    const f = frame("OD", 0, -1).features;
    expect(() =>
      new SimulationOracleEstimator(new Map([[0, -1]])).estimate(f, meta({ simulated: false }), SIM_DEVICE),
    ).toThrow();
    expect(new MlEstimatorUnavailable().estimate(f, meta(), SIM_DEVICE).status).toBe("insufficient");
  });
  it("end-to-end simulated frame produces a sensible meridional estimate", () => {
    const s = makeSubject("TS-E2E", "adult_40_59");
    s.od = { sph: -4, cyl: 0, axis: null };
    const sf = simulateFrame(s, "OD", 0, 1, 0, { blinkRate: 0, motionRate: 0 });
    const { record } = processFrame(
      sf.image,
      sf.iris,
      sf.metadata,
      SIM_DEVICE,
      new PhysicsHeuristicEstimator(),
    );
    expect(record.estimate?.status).toBe("quantitative");
    expect(Math.abs(record.estimate!.powerD! - sf.truthPowerD)).toBeLessThan(1);
  });
});

describe("tracking geometry", () => {
  it("assigns OD to the image-left eye in a raw frame and flips when mirrored", () => {
    const a = { iris: { cx: 200, cy: 100, r: 10 } };
    const b = { iris: { cx: 400, cy: 100, r: 10 } };
    expect(assignSides(a, b).OD).toBe(a);
    expect(assignSides(b, a).OD).toBe(a);
    expect(assignSides(a, b, true).OD).toBe(b);
  });
  it("roll from eyes and from the transformation matrix", () => {
    expect(rollFromEyes({ cx: 0, cy: 10, r: 1 }, { cx: 10, cy: 0, r: 1 })).toBeCloseTo(45);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const hp = headPoseFromMatrix(identity);
    expect(Math.abs(hp.yawDeg) + Math.abs(hp.pitchDeg) + Math.abs(hp.rollDeg)).toBeCloseTo(0);
  });
  it("un-mirroring maps source angle theta -> 180 - theta", () => {
    const m = unmirrorMetadata(meta({ mirrored: true, sourceAngleImageDeg: 30 }));
    expect(m.sourceAngleImageDeg).toBeCloseTo(150);
    expect(circularAxisError(m.sourceAngleImageDeg!, 150)).toBe(0);
  });
});
