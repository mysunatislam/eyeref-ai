/**
 * Geometry from face-landmark output (MediaPipe Face Landmarker, 478 points incl. iris).
 * All coordinates are in RAW camera-frame pixels (never the mirrored preview).
 *
 * Eye identity is decided geometrically, not by landmark naming: viewed from the front in a
 * non-mirrored image, the subject's RIGHT eye (OD) appears on the image LEFT (smaller x).
 */
import type { Circle, EyeSide, HeadPose } from "../types";

export interface Point {
  x: number;
  y: number;
}

/** Landmark index groups for the two eyes (labels are MediaPipe's, mapping to OD/OS is geometric). */
export const EYE_A = { irisCenter: 468, iris: [469, 470, 471, 472], corners: [33, 133], lids: [159, 145] };
export const EYE_B = { irisCenter: 473, iris: [474, 475, 476, 477], corners: [362, 263], lids: [386, 374] };

export interface EyeObservation {
  side: EyeSide;
  iris: Circle;
  corners: [Point, Point];
  lidGapPx: number;
  /** iris centre offset from the eye-corner midpoint, normalised by eye width (gaze proxy) */
  gazeOffset: Point;
  openness: number; // lid gap / iris diameter
}

export function irisCircle(center: Point, boundary: Point[]): Circle {
  const r =
    boundary.reduce((s, p) => s + Math.hypot(p.x - center.x, p.y - center.y), 0) /
    Math.max(boundary.length, 1);
  return { cx: center.x, cy: center.y, r };
}

export function assignSides<T extends { iris: Circle }>(a: T, b: T, mirrored = false): { OD: T; OS: T } {
  // In a raw (non-mirrored) frame the subject's right eye has the smaller x.
  const aIsLeftInImage = a.iris.cx < b.iris.cx;
  const odIsA = mirrored ? !aIsLeftInImage : aIsLeftInImage;
  return odIsA ? { OD: a, OS: b } : { OD: b, OS: a };
}

export function eyeFromLandmarks(pts: Point[], idx: typeof EYE_A, side: EyeSide): EyeObservation {
  const c = pts[idx.irisCenter]!;
  const iris = irisCircle(
    c,
    idx.iris.map((i) => pts[i]!),
  );
  const c0 = pts[idx.corners[0]!]!;
  const c1 = pts[idx.corners[1]!]!;
  const mid = { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 };
  const width = Math.max(Math.hypot(c1.x - c0.x, c1.y - c0.y), 1);
  const lidGap = Math.hypot(
    pts[idx.lids[0]!]!.x - pts[idx.lids[1]!]!.x,
    pts[idx.lids[0]!]!.y - pts[idx.lids[1]!]!.y,
  );
  return {
    side,
    iris,
    corners: [c0, c1],
    lidGapPx: lidGap,
    gazeOffset: { x: (c.x - mid.x) / width, y: (c.y - mid.y) / width },
    openness: lidGap / Math.max(2 * iris.r, 1),
  };
}

/** Build both eye observations from normalised landmarks (0..1) and frame size. */
export function eyesFromLandmarks(
  norm: { x: number; y: number }[],
  frameW: number,
  frameH: number,
  mirrored = false,
): { OD: EyeObservation; OS: EyeObservation } | null {
  if (norm.length < 478) return null;
  const pts = norm.map((p) => ({ x: p.x * frameW, y: p.y * frameH }));
  const a = eyeFromLandmarks(pts, EYE_A, "OD");
  const b = eyeFromLandmarks(pts, EYE_B, "OS");
  const s = assignSides(a, b, mirrored);
  return { OD: { ...s.OD, side: "OD" }, OS: { ...s.OS, side: "OS" } };
}

/**
 * Head pose from MediaPipe's 4x4 facial transformation matrix (column-major).
 * Roll is returned in the TABO sense (counter-clockwise in the image as seen by the camera).
 */
export function headPoseFromMatrix(m: ArrayLike<number>): HeadPose {
  // rotation part, column-major: r_ij = m[j*4 + i]
  const r = (i: number, j: number) => m[j * 4 + i]!;
  const sy = Math.hypot(r(0, 0), r(1, 0));
  const pitch = Math.atan2(r(2, 1), r(2, 2));
  const yaw = Math.atan2(-r(2, 0), sy);
  const roll = Math.atan2(r(1, 0), r(0, 0));
  const d = (x: number) => (x * 180) / Math.PI;
  return { yawDeg: d(yaw), pitchDeg: d(pitch), rollDeg: d(roll) };
}

/** Roll from the inter-pupil line (image y down) - robust fallback when no matrix is available. */
export function rollFromEyes(od: Circle, os: Circle): number {
  // OD is image-left; a CCW head tilt (TABO sense) raises the image-right eye.
  return (Math.atan2(-(os.cy - od.cy), os.cx - od.cx) * 180) / Math.PI;
}

/** Square crop rectangle around the iris (in frame px) for eye analysis. */
export function eyeCropRect(iris: Circle, frameW: number, frameH: number, scale = 1.55) {
  const half = Math.max(8, iris.r * scale);
  const x = Math.max(0, Math.round(iris.cx - half));
  const y = Math.max(0, Math.round(iris.cy - half));
  const size = Math.round(Math.min(2 * half, frameW - x, frameH - y));
  return { x, y, size };
}

export function focalPxFromHfov(imageWidthPx: number, hfovDeg: number): number {
  return imageWidthPx / 2 / Math.tan(((hfovDeg / 2) * Math.PI) / 180);
}

export const HVID_MM = 11.7;
export const HVID_SD_MM = 0.45;

export function distanceFromIris(irisDiameterPx: number, focalPx: number, hvidMm = HVID_MM) {
  const d = (focalPx * (hvidMm / 1000)) / Math.max(irisDiameterPx, 1e-6);
  const rel = Math.sqrt((HVID_SD_MM / hvidMm) ** 2 + 0.05 ** 2 + (1 / Math.max(irisDiameterPx, 1)) ** 2);
  return { distanceM: d, sdM: d * rel };
}
