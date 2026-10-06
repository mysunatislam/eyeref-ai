/**
 * Bench calibration (docs/RESEARCH_PROTOCOL.md stage 0, docs/DEVICE_CALIBRATION.md section 3).
 *
 * A model eye is photographed through trial lenses at a measured distance. Each lens gives it a known
 * refraction, so the run checks the phone's geometry against the photorefraction model and measures the
 * dead-zone gradient gain. A model eye has no face to track: the operator places a search circle over
 * it instead, and its pupil is the aperture the operator enters rather than one scaled from an iris.
 */
import { camel, snake } from "../api";
import { EXTRACTOR_VERSION, extractFeatures } from "../cv/features";
import type { RgbaImage } from "../cv/image";
import { assessQuality, DEFAULT_QUALITY, type QualityConfig } from "../cv/quality";
import type { EyeSegmentation } from "../cv/segmentation";
import { eccentricityMm, effectiveSourceAngle, sourceAngleReferenceDeg } from "../devices";
import type { EccentricGeometry } from "../optics/photorefraction";
import { createRng, normal, seedFrom } from "../random";
import { renderEye } from "../simulation/renderer";
import { SIM_DEVICE } from "../simulation/session";
import type { CaptureMetadata, Circle, DeviceProfile, FrameRecord, Illumination } from "../types";

export const BENCH_RUN_KIND = "eyeref-bench-run";
export const BENCH_RUN_VERSION = 1;

export interface BenchSetup {
  /** from the camera lens to the model eye's cornea, measured with a tape (m) */
  workingDistanceM: number;
  /** the model eye's pupil: its aperture, as set (mm) */
  pupilMm: number;
  /** the model eye's own refraction (D): 0 for an emmetropic model eye */
  eyeRefractionD: number;
  /** from the trial lens to the model eye (mm) */
  vertexMm: number;
  /** the trial lenses, in the order they are captured (D) */
  lensesD: number[];
  /** the phone's rotations on the mount; every lens is captured at each */
  rotationsDeg: number[];
  framesPerStep: number;
}

/** One lens at one rotation. */
export interface BenchStep {
  index: number;
  lensD: number;
  rotationDeg: number;
  /** the model eye's refraction with the lens in front of it */
  refractionD: number;
}

export interface BenchFrame {
  lensD: number;
  refractionD: number;
  rotationDeg: number;
  record: FrameRecord;
}

/** What a run keeps, and what its file holds: enough to analyse it again, here or in Python. */
export interface BenchRun {
  kind: typeof BENCH_RUN_KIND;
  version: number;
  simulated: boolean;
  createdAt: string;
  /** the profile being calibrated, as it was when the run started */
  device: DeviceProfile;
  setup: BenchSetup;
  extractorVersion: string;
  frames: BenchFrame[];
}

export const steps = (from: number, to: number, by: number) =>
  Array.from({ length: Math.round((to - from) / by) + 1 }, (_, i) => Math.round((from + i * by) * 100) / 100);

/** The protocol's stage 0 series: −4 to +4 D in 0.5 D steps. */
export const STAGE0_LENSES = steps(-4, 4, 0.5);

export const DEFAULT_SETUP: BenchSetup = {
  workingDistanceM: 1,
  pupilMm: 6,
  eyeRefractionD: 0,
  vertexMm: 0,
  lensesD: STAGE0_LENSES,
  rotationsDeg: [0, 90],
  framesPerStep: 5,
};

/**
 * The model eye's refraction with a trial lens in front of it. A plus lens makes it myopic: an
 * emmetropic model eye behind a +1.00 D lens needs −1.00 D. The lens's power is taken at the eye.
 */
export function inducedRefraction(lensD: number, eyeRefractionD = 0, vertexMm = 0): number {
  const atEye = lensD / (1 - (vertexMm / 1000) * lensD);
  return eyeRefractionD - atEye;
}

/** The trial lens that gives the model eye a refraction: the inverse of `inducedRefraction`. */
export function lensForRefraction(
  refractionD: number,
  setup: Pick<BenchSetup, "eyeRefractionD" | "vertexMm">,
) {
  const atEye = setup.eyeRefractionD - refractionD;
  return atEye / (1 + (setup.vertexMm / 1000) * atEye);
}

/** Every lens at the first rotation, then every lens at the next: the phone is turned once per rotation. */
export function benchSteps(setup: BenchSetup): BenchStep[] {
  return setup.rotationsDeg.flatMap((rotationDeg, r) =>
    setup.lensesD.map((lensD, l) => ({
      index: r * setup.lensesD.length + l,
      lensD,
      rotationDeg,
      refractionD: inducedRefraction(lensD, setup.eyeRefractionD, setup.vertexMm),
    })),
  );
}

export function benchGeometry(device: DeviceProfile, setup: BenchSetup): EccentricGeometry | null {
  const e = eccentricityMm(device);
  if (e === null) return null;
  return {
    workingDistanceM: setup.workingDistanceM,
    eccentricityM: e / 1000,
    pupilDiameterM: setup.pupilMm / 1000,
  };
}

/** The lenses that put the model eye in the predicted dead zone, ±0.5 D, in 0.25 D steps: for the gain. */
export function deadZoneLenses(device: DeviceProfile, setup: BenchSetup): number[] {
  const g = benchGeometry(device, setup);
  if (!g) return [];
  const centre = -1 / g.workingDistanceM;
  const half = g.eccentricityM / (g.workingDistanceM * g.pupilDiameterM);
  const quarter = (v: number) => Math.round(v * 4) / 4;
  // a stronger plus lens makes the eye more myopic, so the lenses run the other way
  const lo = quarter(lensForRefraction(centre + half, setup) - 0.5);
  const hi = quarter(lensForRefraction(centre - half, setup) + 0.5);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo ? steps(lo, hi, 0.25) : [];
}

/**
 * A bench frame's metadata: the distance is the measured one, and nothing tracks a head. The frame's
 * rotation is how far the browser turned the camera's frames with the screen, when it says; otherwise
 * the step's.
 */
export function benchMetadata(
  setup: BenchSetup,
  step: BenchStep,
  frameIndex: number,
  how: { simulated: boolean; illumination: Illumination; frameRotationDeg?: number | null },
): CaptureMetadata {
  return {
    eye: "OD",
    timestamp: new Date().toISOString(),
    workingDistanceM: setup.workingDistanceM,
    distanceSource: "manual",
    distanceSdM: 0.01,
    deviceRotationDeg: how.frameRotationDeg ?? step.rotationDeg,
    headPose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    illumination: how.illumination,
    sourceAngleImageDeg: null,
    eccentricityMm: null,
    mirrored: false,
    ageGroup: "unknown",
    frameIndex,
    simulated: how.simulated,
    motionPxPerFrame: null,
  };
}

/** The quality check for a model eye: at the measured distance, and with no gaze to check. */
export function benchQuality(setup: BenchSetup): QualityConfig {
  return { ...DEFAULT_QUALITY, targetDistanceM: setup.workingDistanceM, maxGazeOffsetNorm: 10 };
}

/**
 * One bench frame through the on-device feature extractor and quality check. `search` is the circle the
 * pupil is looked for in. The pupil's size in millimetres is the model eye's aperture: the search circle
 * is not an iris, so it cannot scale one.
 */
export function processBenchFrame(
  crop: RgbaImage,
  search: Circle,
  meta: CaptureMetadata,
  device: DeviceProfile,
  setup: BenchSetup,
): { record: FrameRecord; segmentation: EyeSegmentation } {
  const { features, segmentation } = extractFeatures(
    crop,
    effectiveSourceAngle(meta, device),
    search,
    meta.illumination !== "none",
  );
  if (features.pupil) {
    features.pupilDiameterMm = setup.pupilMm;
    features.crescentWidthMm = features.crescentWidthNorm * setup.pupilMm;
  }
  const quality = assessQuality(crop, segmentation, features, meta, benchQuality(setup));
  return { record: { metadata: meta, features, quality, estimate: null }, segmentation };
}

/** Where the simulated scene differs from what the operator entered: how a mistake shows up in a run. */
export interface SimTruth {
  /** the phone that really took the photographs (default: the simulated phone) */
  device?: DeviceProfile;
  /** how much nearer the model eye really is than the distance entered (m) */
  distanceErrorM?: number;
}

export type SimMistake = "none" | "flash-side" | "distance";

/** SIMULATION ONLY: mistakes an operator can make, to see which checks catch them. */
export const SIM_MISTAKES: Record<SimMistake, { label: string; truth: SimTruth }> = {
  none: { label: "None", truth: {} },
  "flash-side": {
    label: "The flash measured on the wrong side of the lens",
    truth: { device: { ...SIM_DEVICE, flashOffsetMm: [0, 9.4] } },
  },
  distance: {
    label: "The model eye 25 cm nearer than the distance entered",
    truth: { distanceErrorM: 0.25 },
  },
};

/**
 * SIMULATION ONLY: a model eye rendered behind the step's lens. The scene is laid out as `truth` says,
 * whatever the profile being calibrated claims, so a profile with the wrong geometry shows up in the run
 * as it would on the bench.
 */
export function simulateBenchFrame(
  setup: BenchSetup,
  step: BenchStep,
  frameIndex: number,
  seed: number,
  truth: SimTruth = {},
): { image: RgbaImage; search: Circle } {
  const device = truth.device ?? SIM_DEVICE;
  const rng = createRng(seedFrom(`bench|${step.lensD}|${step.rotationDeg}|${frameIndex}|${seed}`));
  const { image, truth: t } = renderEye({
    refraction: { sph: step.refractionD, cyl: 0, axis: null },
    accommodationD: 0,
    pupilDiameterMm: setup.pupilMm,
    workingDistanceM: setup.workingDistanceM - (truth.distanceErrorM ?? 0),
    eccentricityMm: eccentricityMm(device) ?? 8,
    sourceAngleImageDeg: ((sourceAngleReferenceDeg(device) ?? 270) + step.rotationDeg) % 360,
    headRollDeg: 0,
    irisRgb: [58, 54, 52], // the model eye's grey housing
    skinRgb: [34, 32, 32],
    fundusReflectance: 0.85,
    gazeOffset: [0, 0],
    eyelidOpening: 1,
    blurSigmaPx: 0.6,
    noiseSd: 3,
    seed: Math.floor(rng() * 2 ** 31),
  });
  const c = (image.width - 1) / 2;
  return { image, search: { cx: c + normal(rng, 0, 0.5), cy: c + normal(rng, 0, 0.5), r: t.irisRadiusPx } };
}

/** A frame as captured, with what the extractor saw: for showing it. */
export interface BenchShot {
  frame: BenchFrame;
  image: RgbaImage;
  segmentation: EyeSegmentation;
}

/** SIMULATION ONLY: one step's frames, rendered and run through the same extractor as a real capture. */
export function simulateStep(
  run: BenchRun,
  step: BenchStep,
  truth: SimTruth = {},
  seed = 1,
  onShot?: (shot: BenchShot) => void,
): BenchFrame[] {
  return Array.from({ length: run.setup.framesPerStep }, (_, i) => {
    const frameIndex = step.index * run.setup.framesPerStep + i;
    const { image, search } = simulateBenchFrame(run.setup, step, frameIndex, seed, truth);
    const meta = benchMetadata(run.setup, step, frameIndex, { simulated: true, illumination: "torch" });
    const { record, segmentation } = processBenchFrame(image, search, meta, run.device, run.setup);
    const frame = { lensD: step.lensD, refractionD: step.refractionD, rotationDeg: step.rotationDeg, record };
    onShot?.({ frame, image, segmentation });
    return frame;
  });
}

export function newRun(
  device: DeviceProfile,
  setup: BenchSetup,
  simulated: boolean,
  createdAt = new Date(),
): BenchRun {
  return {
    kind: BENCH_RUN_KIND,
    version: BENCH_RUN_VERSION,
    simulated,
    createdAt: createdAt.toISOString(),
    device,
    setup,
    extractorVersion: EXTRACTOR_VERSION,
    frames: [],
  };
}

/** A step's frames in place of any it had: a retake replaces the step. */
export function withStep(run: BenchRun, step: BenchStep, frames: BenchFrame[]): BenchRun {
  const other = run.frames.filter((f) => !(f.lensD === step.lensD && f.rotationDeg === step.rotationDeg));
  return { ...run, frames: [...other, ...frames] };
}

export const stepFrames = (run: BenchRun, step: BenchStep) =>
  run.frames.filter((f) => f.lensD === step.lensD && f.rotationDeg === step.rotationDeg);

/** The run's file, in the backend's field names, so `python -m eyeref.research.bench_run` reads it. */
export function runFile(run: BenchRun): string {
  return JSON.stringify(snake(run), null, 1);
}

export function runFileName(run: BenchRun): string {
  const kind = run.simulated ? "simulated-bench" : "bench";
  return `eyeref-${kind}-${run.device.id}-${run.createdAt.slice(0, 19).replace(/:/g, "")}.json`;
}

export class BenchFileError extends Error {}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numbers = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(isNum);

/** Why `run` is not a bench run this app can show, or null when it is. */
export function benchRunProblem(run: unknown): string | null {
  const r = run as Partial<BenchRun> | null;
  if (!r || typeof r !== "object" || r.kind !== BENCH_RUN_KIND) return "This is not an EyeRef bench run.";
  if (r.version !== BENCH_RUN_VERSION)
    return `This is a version ${String(r.version)} bench run; this app reads version ${BENCH_RUN_VERSION}.`;
  const s = r.setup;
  const setupOk =
    !!s &&
    [s.workingDistanceM, s.pupilMm, s.eyeRefractionD, s.vertexMm, s.framesPerStep].every(isNum) &&
    numbers(s.lensesD) &&
    numbers(s.rotationsDeg);
  const framesOk =
    Array.isArray(r.frames) &&
    r.frames.every(
      (f) =>
        !!f &&
        [f.lensD, f.refractionD, f.rotationDeg].every(isNum) &&
        !!f.record?.metadata &&
        !!f.record.features &&
        !!f.record.quality,
    );
  if (!r.device || typeof r.simulated !== "boolean" || !setupOk || !framesOk)
    return "This bench run is incomplete.";
  return null;
}

export function readRunFile(text: string): BenchRun {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BenchFileError("This file is not JSON, so it is not a bench run.");
  }
  const run = camel<BenchRun>(raw);
  const problem = benchRunProblem(run);
  if (problem) throw new BenchFileError(problem);
  return run;
}
