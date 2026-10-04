/**
 * Guided capture protocol shared by the live camera flow and Simulation Mode.
 *
 * One protocol "step" = one device rotation (= one photorefraction meridian). Both eyes are
 * captured in the same frames, as in clinical photoscreeners, so OD/OS see identical geometry.
 * The light source is pulsed only while frames are grabbed so the pupil does not constrict.
 */
import { EXTRACTOR_VERSION } from "../cv/features";
import type { RgbaImage } from "../cv/image";
import { getDevice } from "../devices";
import {
  MlEstimatorUnavailable,
  PhysicsHeuristicEstimator,
  type PhotorefractionEstimator,
} from "../inference/estimators";
import { buildReport, DEFAULT_GATING, type GatingConfig } from "../inference/fusion";
import { processFrame } from "../inference/pipeline";
import {
  makeSubject,
  SIM_DEVICE,
  simulateFrame,
  subjectTruth,
  type VirtualSubject,
} from "../simulation/session";
import type { Settings } from "../settings";
import type {
  AgeGroup,
  DeviceProfile,
  EyeSide,
  FrameRecord,
  StoredAssessment,
  SubjectProfile,
} from "../types";
import type { EyeSegmentation } from "../cv/segmentation";

export const PROTOCOL_VERSION = "guided-1";
export const TORCH_SETTLE_MS = 250;
export const FRAME_INTERVAL_MS = 90;
export const COUNTDOWN_S = 3;

export interface ProtocolStep {
  index: number;
  rotationDeg: number;
  label: string;
}

export function buildProtocol(meridians: number[]): ProtocolStep[] {
  const uniq = [...new Set(meridians.map((m) => ((Math.round(m) % 180) + 180) % 180))];
  const list = uniq.length ? uniq : [0];
  return list.map((rotationDeg, index) => ({
    index,
    rotationDeg,
    label: rotationDeg === 0 ? "Upright" : `Rotate ${rotationDeg}°`,
  }));
}

/** Physics estimator is the default everywhere; the learned model is unavailable until trained on real data. */
export function estimatorFor(kind: "physics" | "ml" = "physics"): PhotorefractionEstimator {
  return kind === "ml" ? new MlEstimatorUnavailable() : new PhysicsHeuristicEstimator();
}

export function activeDevice(settings: Settings): DeviceProfile {
  return settings.simulationMode ? SIM_DEVICE : getDevice(settings.deviceId, settings.customDevices);
}

export function gatingFrom(settings: Settings): GatingConfig {
  return { ...DEFAULT_GATING, astigmatismQuantificationEnabled: settings.astigmatismQuantification };
}

/* ------------------------------------------------------------------ Simulation presets */

export interface SimPreset {
  id: string;
  label: string;
  description: string;
  apply?: (s: VirtualSubject) => void;
}

export const SIM_PRESETS: SimPreset[] = [
  {
    id: "random",
    label: "Random virtual subject",
    description: "Seeded from the subject label; mixed refractive errors.",
  },
  {
    id: "myope",
    label: "Moderate myope",
    description: "−3.00 D sphere both eyes.",
    apply: (s) => ((s.od = { sph: -3, cyl: 0, axis: null }), (s.os = { sph: -3.25, cyl: 0, axis: null })),
  },
  {
    id: "hyperope",
    label: "Hyperope",
    description: "+2.50 D. Watch accommodation hide part of it (latent hyperopia).",
    apply: (s) => ((s.od = { sph: 2.5, cyl: 0, axis: null }), (s.os = { sph: 2.25, cyl: 0, axis: null })),
  },
  {
    id: "emmetrope",
    label: "Emmetrope",
    description: "Plano. Falls inside the dead zone: expect an interval, not a number.",
    apply: (s) => ((s.od = { sph: 0, cyl: 0, axis: null }), (s.os = { sph: 0.25, cyl: 0, axis: null })),
  },
  {
    id: "astigmat",
    label: "Myopic astigmat",
    description: "−2.00 / −1.50 × 180. CYL/AXIS only shown if the research flag is on and gates pass.",
    apply: (s) => ((s.od = { sph: -2, cyl: -1.5, axis: 180 }), (s.os = { sph: -2, cyl: -1.5, axis: 175 })),
  },
  {
    id: "aniso",
    label: "Anisometrope",
    description: "OD −0.50, OS −3.50: tests the anisometropia flag.",
    apply: (s) => ((s.od = { sph: -0.5, cyl: 0, axis: null }), (s.os = { sph: -3.5, cyl: 0, axis: null })),
  },
];

export function makeVirtualSubject(label: string, ageGroup: AgeGroup, presetId: string): VirtualSubject {
  const s = makeSubject(`${label || "SIM"}|${presetId}`, ageGroup);
  SIM_PRESETS.find((p) => p.id === presetId)?.apply?.(s);
  return s;
}

export interface CapturedEye {
  eye: EyeSide;
  image: RgbaImage;
  segmentation: EyeSegmentation;
  record: FrameRecord;
}

/** Render and process one simulated binocular frame through the real on-device pipeline. */
export function captureSimulatedFrame(
  subject: VirtualSubject,
  rotationDeg: number,
  frameIndex: number,
  sessionSeed: number,
  estimator: PhotorefractionEstimator,
  targetDistanceM: number,
): CapturedEye[] {
  return (["OD", "OS"] as const).map((eye) => {
    const sf = simulateFrame(subject, eye, rotationDeg, frameIndex, sessionSeed, { targetDistanceM });
    const { record, segmentation } = processFrame(sf.image, sf.iris, sf.metadata, SIM_DEVICE, estimator);
    record.simTruth = { powerInMeridianD: sf.truthPowerD, meridianDeg: sf.truthMeridianDeg };
    return { eye, image: sf.image, segmentation, record };
  });
}

export function finalizeAssessment(args: {
  frames: FrameRecord[];
  profile: SubjectProfile;
  settings: Settings;
  estimator: PhotorefractionEstimator;
  subject?: VirtualSubject;
}): StoredAssessment {
  const device = activeDevice(args.settings);
  const report = buildReport({
    frames: args.frames,
    ageGroup: args.profile.ageGroup,
    deviceId: device.id,
    calibrationVersion: device.calibrationVersion,
    estimator: { name: args.estimator.name, version: args.estimator.version, kind: args.estimator.kind },
    extractorVersion: EXTRACTOR_VERSION,
    gating: gatingFrom(args.settings),
    symptomsReported: args.profile.symptoms,
  });
  return {
    id: report.id,
    createdAt: report.provenance.timestamp,
    profile: args.profile,
    report,
    frames: args.frames,
    visionTests: [],
    simTruth: args.subject ? subjectTruth(args.subject) : undefined,
  };
}
