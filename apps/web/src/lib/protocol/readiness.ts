/**
 * Capture-readiness indicators shared by the live camera and Simulation Mode.
 * Thresholds deliberately mirror the quality model so the guidance predicts acceptance.
 */
import { DEFAULT_GATING } from "../inference/fusion";
import { HARD_FAILURE_TEXT, isUsable } from "../cv/quality";
import type { FrameRecord, QualityGrade } from "../types";

export type IndicatorState = "ok" | "warn" | "bad" | "idle";

export interface Indicator {
  key: string;
  label: string;
  value: string;
  state: IndicatorState;
  hint?: string;
}

export interface ReadinessInput {
  face: boolean;
  distanceM: number | null;
  targetDistanceM: number;
  luma: number | null;
  yawDeg: number | null;
  pitchDeg: number | null;
  rollDeg: number | null;
  gaze: number | null;
  blink: number | null;
  motionPx: number | null;
  pupilMm: number | null;
  grade: QualityGrade | null;
  flashAvailable: boolean;
  /** why there is no light beside the lens, in words the person can act on */
  flashMissingHint?: string;
  /** the probed rotation less the step's, on the meridian circle */
  deviceRotationErrorDeg: number | null;
  /** which way to turn the phone, as you look at its screen, to reach the step's angle */
  deviceTurn?: "clockwise" | "anticlockwise" | null;
}

const f = (v: number | null, d = 1, unit = "") =>
  v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${unit}`;

/** Why a live camera has no light beside its lens, or null when it has one. */
export function flashMissing(args: {
  hasSource: boolean;
  facing: "user" | "environment";
  torch: boolean;
  deviceCamera: string;
}): string | null {
  if (!args.hasSource) return "This device profile has no light beside the lens: choose a phone profile";
  if (args.deviceCamera !== "rear") return null;
  if (args.facing === "user") return "The front camera has no flash beside it: switch to the back camera";
  if (!args.torch) return "The browser did not report a flash: tap Test flash under the picture";
  return null;
}

export function evaluateReadiness(r: ReadinessInput): { indicators: Indicator[]; ready: boolean } {
  const ind: Indicator[] = [];
  const add = (key: string, label: string, value: string, state: IndicatorState, hint?: string) =>
    ind.push({ key, label, value, state, hint });

  add(
    "face",
    "Face",
    r.face ? "Tracked" : "Not found",
    r.face ? "ok" : "bad",
    r.face
      ? undefined
      : r.luma !== null && r.luma < 0.08
        ? "Too dark to find the face: put a lamp or a screen behind the phone"
        : "Centre the face in the frame",
  );

  if (r.distanceM === null) add("distance", "Distance", "—", "idle");
  else {
    const rel = (r.distanceM - r.targetDistanceM) / r.targetDistanceM;
    const st = Math.abs(rel) <= 0.1 ? "ok" : Math.abs(rel) <= 0.2 ? "warn" : "bad";
    add("distance", "Distance", f(r.distanceM, 2, " m"), st, distanceAdvice(r.distanceM, r.targetDistanceM));
  }

  // The camera brightens a dim face by itself, so the face's brightness says little about the room: the
  // pupil, which is what the room's light changes, decides when it is measured, and light never blocks.
  if (r.pupilMm !== null)
    add(
      "light",
      "Room light",
      r.pupilMm >= 4 ? "Dim enough" : "Too bright",
      r.pupilMm >= 4 ? "ok" : "warn",
      r.pupilMm >= 4 ? undefined : "Dim the room so the pupils widen",
    );
  else if (r.luma === null) add("light", "Room light", "—", "idle");
  else {
    const dark = r.luma < 0.04;
    const bright = r.luma > 0.5;
    add(
      "light",
      "Room light",
      dark ? "Very dark" : bright ? "Bright" : "Dim",
      dark || bright ? "warn" : "ok",
      dark
        ? "Too dark to see the face: put a lamp or a screen behind the phone"
        : bright
          ? "Dim the room so the pupils widen"
          : undefined,
    );
  }

  const pose = Math.max(Math.abs(r.yawDeg ?? 0), Math.abs(r.pitchDeg ?? 0));
  add(
    "pose",
    "Head pose",
    r.yawDeg === null ? "—" : `${f(pose, 0, "°")}`,
    r.yawDeg === null ? "idle" : pose <= 8 ? "ok" : pose <= 15 ? "warn" : "bad",
    pose > 8 ? "Face the camera straight on" : undefined,
  );

  add(
    "gaze",
    "Gaze",
    r.gaze === null ? "—" : r.gaze < 0.08 ? "On target" : "Off target",
    r.gaze === null ? "idle" : r.gaze < 0.08 ? "ok" : r.gaze < 0.14 ? "warn" : "bad",
    r.gaze !== null && r.gaze >= 0.08 ? "Look at the light next to the lens" : undefined,
  );

  add(
    "blink",
    "Eyes open",
    r.blink === null ? "—" : r.blink < 0.35 ? "Open" : "Blink",
    r.blink === null ? "idle" : r.blink < 0.35 ? "ok" : "bad",
  );

  add(
    "motion",
    "Stability",
    r.motionPx === null ? "—" : `${f(r.motionPx, 1, " px")}`,
    r.motionPx === null ? "idle" : r.motionPx < 2 ? "ok" : r.motionPx < 4 ? "warn" : "bad",
    r.motionPx !== null && r.motionPx >= 2 ? "Hold still / rest the phone" : undefined,
  );

  add(
    "pupil",
    "Pupil",
    f(r.pupilMm, 1, " mm"),
    r.pupilMm === null ? "idle" : r.pupilMm >= 4 ? "ok" : r.pupilMm >= 3.2 ? "warn" : "bad",
    r.pupilMm !== null && r.pupilMm < 4 ? "Dim the room and wait 60 s" : undefined,
  );

  add(
    "flash",
    "Light source",
    r.flashAvailable ? "Available" : "Missing",
    r.flashAvailable ? "ok" : "bad",
    r.flashAvailable
      ? undefined
      : (r.flashMissingHint ?? "No light beside the lens: the eyes cannot be measured"),
  );

  if (r.deviceRotationErrorDeg !== null) {
    const off = Math.abs(r.deviceRotationErrorDeg);
    add(
      "meridian",
      "Device angle",
      `${f(off, 0, "°")} off`,
      off <= 7 ? "ok" : off <= 15 ? "warn" : "bad",
      off <= 7
        ? undefined
        : r.deviceTurn
          ? `Turn the phone ${r.deviceTurn}`
          : "Rotate the phone to the target angle",
    );
  }

  add(
    "quality",
    "Frame quality",
    r.grade ?? "—",
    r.grade === null
      ? "idle"
      : r.grade === "excellent" || r.grade === "acceptable"
        ? "ok"
        : r.grade === "poor"
          ? "warn"
          : "bad",
  );

  const blocking = ind.filter((i) => i.state === "bad" && i.key !== "quality" && i.key !== "pupil");
  return { indicators: ind, ready: r.face && blocking.length === 0 };
}

/** Signed smallest difference between two device rotations on the 180° meridian circle. */
export function rotationError(measuredDeg: number, targetDeg: number): number {
  return ((((measuredDeg - targetDeg) % 180) + 270) % 180) - 90;
}

/**
 * Which way to move, and roughly how far, to reach the target distance; undefined within 5%. Steps are in
 * 5 cm, as a person can judge them.
 */
export function distanceAdvice(distanceM: number, targetM: number): string | undefined {
  const gap = distanceM - targetM;
  if (Math.abs(gap) <= 0.05 * targetM) return undefined;
  const cm = Math.max(5, Math.round((Math.abs(gap) * 100) / 5) * 5);
  return gap > 0 ? `Move closer, about ${cm} cm` : `Move back, about ${cm} cm`;
}

export interface BurstSummary {
  usable: number;
  total: number;
  /** usable images needed from each eye */
  needed: number;
  /** the commonest reasons images were rejected, most frequent first */
  reasons: string[];
  /** what to change for the commonest reason */
  fix?: string;
}

/** What the person can change for each reason an image is rejected (cv/quality HARD_FAILURE_TEXT). */
export const FAILURE_FIX: Record<string, string> = {
  pupil_not_found: "Keep both eyes wide open and look at the flash.",
  image_blurred: "Rest the phone on something steady and keep still.",
  too_few_pixels: "Wait for the picture to zoom in before you capture.",
  reflex_saturated:
    "The eyes came out too bright: add a little light behind the phone (a lamp or screen) so the camera exposes less, and keep 1 m away.",
  excessive_glare:
    "A bright reflection covers the pupil: use only this phone's flash, with no other torch or lamp shining at the eyes.",
  pupil_occluded: "Open the eyes wide, without squinting at the flash.",
  pupil_too_small: "Make the room dimmer and wait a minute for the pupils to widen.",
  head_rotated: "Face the phone straight on, chin level.",
  gaze_off_axis: "Look straight at the flash beside the camera lens.",
  motion: "Rest the phone on something steady and keep still.",
  distance_out_of_range: "Stay at about 1 m from the phone.",
  no_red_reflex: "The flash did not light the eyes: tap Test flash, and use this phone's own flash.",
  face_lost: "Keep the face in the middle of the picture and still until the beep.",
};

/** What one capture gave: usable eye images, and why the others were rejected. */
export function burstSummary(recs: FrameRecord[], framesPerEye: number): BurstSummary {
  const counts = new Map<string, number>();
  for (const r of recs)
    if (!isUsable(r.quality)) for (const h of r.quality.hardFailures) counts.set(h, (counts.get(h) ?? 0) + 1);
  // frames the tracker lost the face in never become records (one record per eye per frame)
  const lost = 2 * framesPerEye - recs.length;
  if (lost > 0) counts.set("face_lost", lost);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const usable = recs.filter((r) => isUsable(r.quality)).length;
  const needed = 2 * DEFAULT_GATING.minUsableFramesPerMeridian;
  return {
    usable,
    total: 2 * framesPerEye,
    needed,
    reasons: top.map(([k]) => (k === "face_lost" ? "Face lost in some frames" : (HARD_FAILURE_TEXT[k] ?? k))),
    fix: usable < needed && top.length ? FAILURE_FIX[top[0]![0]] : undefined,
  };
}
