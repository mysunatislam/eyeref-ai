/**
 * SIMULATION / DEVELOPMENT MODE: deterministic virtual subjects and capture sessions.
 * The synthetic frames are processed by the REAL on-device pipeline (segmentation, features,
 * quality, physics estimator, fusion), so simulation exercises the actual algorithms. Every
 * record is flagged simulated and the UI labels it "SIMULATED DATA".
 */
import { DEVICE_PROFILES, eccentricityMm, sourceAngleReferenceDeg } from "../devices";
import { ACCOMMODATION_AMPLITUDE_D, ACCOMMODATION_SD } from "../optics/classification";
import { fromPowerVector, sphericalEquivalent, toPowerVector, type SphCylAxis } from "../optics/powerVector";
import { createRng, normal, seedFrom, uniform } from "../random";
import type { AgeGroup, CaptureMetadata, Circle, EyeSide } from "../types";
import type { RgbaImage } from "../cv/image";
import { renderEye } from "./renderer";

export const SIM_DEVICE = DEVICE_PROFILES.find((d) => d.id === "simulated-phone")!;
const AGE_GROUPS: AgeGroup[] = [
  "child_3_7",
  "child_8_12",
  "teen",
  "adult_18_39",
  "adult_40_59",
  "adult_60_plus",
];
const PUPIL_BY_AGE: Record<AgeGroup, number> = {
  child_3_7: 6.8,
  child_8_12: 6.8,
  teen: 6.6,
  adult_18_39: 6.2,
  adult_40_59: 5.4,
  adult_60_plus: 4.6,
  unknown: 6,
};
const IRIS: [number, number, number][] = [
  [92, 64, 44],
  [60, 40, 28],
  [120, 96, 60],
  [88, 110, 128],
  [70, 92, 70],
];
const SKIN: [number, number, number][] = [
  [232, 196, 172],
  [198, 150, 120],
  [160, 110, 80],
  [110, 74, 52],
  [72, 48, 36],
];

export interface VirtualSubject {
  id: string;
  ageGroup: AgeGroup;
  od: SphCylAxis;
  os: SphCylAxis;
  pupilMm: number;
  irisRgb: [number, number, number];
  skinRgb: [number, number, number];
  fundusReflectance: number;
  /**
   * How fully the eyes focus on the light: the share of what the eye that can see it with least effort
   * needs. The light is about a metre away, so an eye that can focus on it does, and reads more myopic.
   */
  focusResponse: number;
}

/** The share of what they need that simulated eyes focus on the light: most of the way, as people do. */
export const SIM_FOCUS_RESPONSE_RANGE: [number, number] = [0.5, 1];

const q = (v: number) => Math.round(v * 4) / 4;

export function makeSubject(id: string, ageGroup?: AgeGroup): VirtualSubject {
  const rng = createRng(seedFrom(id));
  const age =
    ageGroup && ageGroup !== "unknown" ? ageGroup : AGE_GROUPS[Math.floor(rng() * AGE_GROUPS.length)]!;
  const mix = rng();
  let M = mix < 0.45 ? normal(rng, -2.5, 1.8) : mix < 0.75 ? normal(rng, 0, 0.5) : normal(rng, 1.8, 1.2);
  M = Math.max(-9, Math.min(7, M));
  const cyl = -Math.abs(normal(rng, 0.45, 0.4));
  const r = rng();
  const axis =
    (((r < 0.55 ? normal(rng, 180, 12) : r < 0.85 ? normal(rng, 90, 12) : uniform(rng, 0, 180)) % 180) +
      180) %
    180;
  const od: SphCylAxis = { sph: q(M - cyl / 2), cyl: q(cyl), axis };
  const pv = toPowerVector(od);
  const dM = normal(rng, 0, 0.35) + (rng() < 0.08 ? normal(rng, 0, 2) : 0);
  const os0 = fromPowerVector({
    M: pv.M + dM,
    J0: pv.J0 + normal(rng, 0, 0.1),
    J45: -pv.J45 + normal(rng, 0, 0.1),
  });
  return {
    id,
    ageGroup: age,
    od,
    os: { sph: q(os0.sph), cyl: q(os0.cyl), axis: os0.axis },
    pupilMm: Math.max(3.2, Math.min(8, normal(rng, PUPIL_BY_AGE[age], 0.6))),
    irisRgb: IRIS[Math.floor(rng() * IRIS.length)]!,
    skinRgb: SKIN[Math.floor(rng() * SKIN.length)]!,
    fundusReflectance: uniform(rng, 0.6, 1),
    focusResponse: uniform(rng, ...SIM_FOCUS_RESPONSE_RANGE),
  };
}

/**
 * How far the eyes focus on a light `distanceM` away (D). The eyes focus together, to clear the eye that
 * needs least; an eye more myopic than the light is near cannot see it clearly, and when neither can, the
 * eyes stay relaxed. Twin of eyeref.simulation.cohort.focus_on_light.
 */
export function focusOnLight(s: VirtualSubject, distanceM: number): number {
  const demands = [s.od, s.os].map((rx) => sphericalEquivalent(rx) + 1 / distanceM).filter((d) => d >= 0);
  if (!demands.length) return 0;
  return Math.min(ACCOMMODATION_AMPLITUDE_D[s.ageGroup], s.focusResponse * Math.min(...demands));
}

export function subjectTruth(s: VirtualSubject) {
  const t = (rx: SphCylAxis) => ({ sph: rx.sph, cyl: rx.cyl, axis: rx.axis, se: sphericalEquivalent(rx) });
  return { OD: t(s.od), OS: t(s.os) };
}

export interface SimulatedFrame {
  image: RgbaImage;
  iris: Circle;
  metadata: CaptureMetadata;
  truthPowerD: number;
  truthMeridianDeg: number;
}

/**
 * The simulated phone's screen at a rotation (anticlockwise), as a phone with auto-rotate on and
 * upside-down portrait off turns it: portrait until the phone is well over on its side, then landscape
 * the way it was turned.
 */
export function simulatedScreenAngle(deviceRotationDeg: number): number {
  const r = ((deviceRotationDeg % 360) + 360) % 360;
  return r >= 67.5 && r < 180 ? 90 : r >= 180 && r <= 292.5 ? 270 : 0;
}

/**
 * Render one frame for a given eye + device rotation (used by both batch sessions and the live sim stage).
 * By default the frame turns with the phone, so the head is upright in it. A real browser turns the
 * frame only with the screen: `frameRotationDeg` sets that turn, and the rest of the phone's rotation then
 * shows as the head's tilt in the frame, as on a real phone.
 */
export function simulateFrame(
  s: VirtualSubject,
  eye: EyeSide,
  deviceRotationDeg: number,
  frameIndex: number,
  sessionSeed = 0,
  opts: { blinkRate?: number; motionRate?: number; targetDistanceM?: number; frameRotationDeg?: number } = {},
): SimulatedFrame {
  const rng = createRng(seedFrom(`${s.id}|${eye}|${deviceRotationDeg}|${frameIndex}|${sessionSeed}`));
  const trueD = Math.max(0.6, Math.min(1.5, normal(rng, opts.targetDistanceM ?? 1, 0.06)));
  const frameRotationDeg = opts.frameRotationDeg ?? deviceRotationDeg;
  const roll = frameRotationDeg - deviceRotationDeg + normal(rng, 0, 3);
  // focusing drifts from moment to moment, in both eyes at once
  const drift = createRng(seedFrom(`${s.id}|focus|${deviceRotationDeg}|${frameIndex}|${sessionSeed}`));
  const acc = Math.max(0, focusOnLight(s, trueD) + normal(drift, 0, ACCOMMODATION_SD[s.ageGroup] * 0.3));
  const blink = rng() < (opts.blinkRate ?? 0.06);
  const motion = rng() < (opts.motionRate ?? 0.06);
  const src = ((((sourceAngleReferenceDeg(SIM_DEVICE) ?? 270) + frameRotationDeg) % 360) + 360) % 360;
  const { image, truth } = renderEye({
    refraction: eye === "OD" ? s.od : s.os,
    accommodationD: acc,
    pupilDiameterMm: s.pupilMm + normal(rng, 0, 0.15),
    workingDistanceM: trueD,
    eccentricityMm: eccentricityMm(SIM_DEVICE) ?? 8,
    sourceAngleImageDeg: src,
    headRollDeg: roll,
    irisRgb: s.irisRgb,
    skinRgb: s.skinRgb,
    fundusReflectance: s.fundusReflectance,
    gazeOffset: [normal(rng, 0, 0.08), normal(rng, 0, 0.08)],
    eyelidOpening: blink ? 0.18 : uniform(rng, 0.8, 1),
    blurSigmaPx: uniform(rng, 0.4, 0.9) + (motion ? 2.8 : 0),
    exposure: uniform(rng, 0.9, 1.1),
    noiseSd: uniform(rng, 2, 4),
    seed: Math.floor(rng() * 2 ** 31),
  });
  const c = (image.width - 1) / 2;
  const metadata: CaptureMetadata = {
    eye,
    timestamp: new Date().toISOString(),
    workingDistanceM: trueD + normal(rng, 0, 0.05),
    distanceSource: "simulated",
    distanceSdM: 0.05,
    deviceRotationDeg: frameRotationDeg,
    headPose: { yawDeg: normal(rng, 0, 3), pitchDeg: normal(rng, 0, 3), rollDeg: roll },
    illumination: "flash",
    sourceAngleImageDeg: null,
    eccentricityMm: null,
    mirrored: false,
    ageGroup: s.ageGroup,
    frameIndex,
    simulated: true,
    motionPxPerFrame: motion ? 6 : Math.abs(normal(rng, 0.6, 0.3)),
  };
  return {
    image,
    metadata,
    truthPowerD: truth.powerInMeridianD,
    truthMeridianDeg: truth.meridianEyeDeg,
    iris: {
      cx: c + normal(rng, 0, 1),
      cy: c + normal(rng, 0, 1),
      r: truth.irisRadiusPx * normal(rng, 1, 0.03),
    },
  };
}
