/**
 * Capture-readiness indicators shared by the live camera and Simulation Mode.
 * Thresholds deliberately mirror the quality model so the guidance predicts acceptance.
 */
import type { QualityGrade } from "../types";

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
  deviceRotationErrorDeg: number | null;
}

const f = (v: number | null, d = 1, unit = "") =>
  v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${unit}`;

export function evaluateReadiness(r: ReadinessInput): { indicators: Indicator[]; ready: boolean } {
  const ind: Indicator[] = [];
  const add = (key: string, label: string, value: string, state: IndicatorState, hint?: string) =>
    ind.push({ key, label, value, state, hint });

  add(
    "face",
    "Face",
    r.face ? "Tracked" : "Not found",
    r.face ? "ok" : "bad",
    r.face ? undefined : "Centre the face in the frame",
  );

  if (r.distanceM === null) add("distance", "Distance", "—", "idle");
  else {
    const rel = (r.distanceM - r.targetDistanceM) / r.targetDistanceM;
    const st = Math.abs(rel) <= 0.1 ? "ok" : Math.abs(rel) <= 0.2 ? "warn" : "bad";
    add(
      "distance",
      "Distance",
      f(r.distanceM, 2, " m"),
      st,
      rel > 0 ? "Move closer" : rel < 0 ? "Move back" : undefined,
    );
  }

  if (r.luma === null) add("light", "Room light", "—", "idle");
  else {
    const st = r.luma > 0.55 ? "bad" : r.luma > 0.4 ? "warn" : r.luma < 0.04 ? "warn" : "ok";
    add(
      "light",
      "Room light",
      r.luma > 0.4 ? "Too bright" : r.luma < 0.04 ? "Very dark" : "Dim",
      st,
      r.luma > 0.4 ? "Dim the room so the pupils dilate" : undefined,
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
    r.flashAvailable ? undefined : "No eccentric source: photorefraction impossible",
  );

  if (r.deviceRotationErrorDeg !== null)
    add(
      "meridian",
      "Device angle",
      `${f(r.deviceRotationErrorDeg, 0, "°")} off`,
      Math.abs(r.deviceRotationErrorDeg) <= 7
        ? "ok"
        : Math.abs(r.deviceRotationErrorDeg) <= 15
          ? "warn"
          : "bad",
      "Rotate the phone to the target angle",
    );

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
