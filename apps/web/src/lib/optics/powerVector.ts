/**
 * Ophthalmic refraction mathematics (TypeScript twin of backend/eyeref/optics/power_vector.py).
 *
 *   M   = S + C/2
 *   J0  = -(C/2) cos(2a)
 *   J45 = -(C/2) sin(2a)
 *   P(theta) = S + C sin^2(theta - a) = M + J0 cos(2 theta) + J45 sin(2 theta)
 *
 * Axes are TABO degrees in [0, 180). Axis is never averaged or regressed as a raw
 * scalar; it is recovered from the doubled angle.
 */

export interface SphCylAxis {
  sph: number;
  cyl: number;
  axis: number | null;
}

export interface PowerVector {
  M: number;
  J0: number;
  J45: number;
}

const EPS = 1e-6;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function normalizeAxis(a: number): number {
  let x = a % 180;
  if (x < 0) x += 180;
  return Math.abs(x - 180) < 1e-9 ? 0 : x;
}

/** Prescription-style integer axis 1..180 (0 is written as 180). */
export function displayAxis(a: number): number {
  const r = Math.round(normalizeAxis(a));
  return r === 0 || r === 180 ? 180 : r;
}

export function formatAxis(a: number | null | undefined): string {
  if (a === null || a === undefined) return "---";
  return `${String(displayAxis(a)).padStart(3, "0")}°`;
}

/** Smallest difference between two axes (period 180). circularAxisError(179, 1) === 2 */
export function circularAxisError(a: number, b: number): number {
  const d = Math.abs(normalizeAxis(a) - normalizeAxis(b));
  return Math.min(d, 180 - d);
}

export function axisToDoubledUnit(a: number): [number, number] {
  return [Math.cos(rad(2 * a)), Math.sin(rad(2 * a))];
}

export function doubledUnitToAxis(c2: number, s2: number): number {
  return normalizeAxis(deg(Math.atan2(s2, c2)) / 2);
}

/** Left-right image flip: theta -> 180 - theta. Use when un-mirroring selfie previews. */
export function mirrorAxisHorizontal(a: number): number {
  return normalizeAxis(180 - a);
}

export function rotateAxis(a: number, rotationDeg: number): number {
  return normalizeAxis(a + rotationDeg);
}

/** Image direction (x right, y DOWN) -> TABO angle in [0, 360). */
export function imageVectorToTabo(dx: number, dyImage: number): number {
  const a = deg(Math.atan2(-dyImage, dx));
  return ((a % 360) + 360) % 360;
}

export function sphericalEquivalent(rx: SphCylAxis): number {
  return rx.sph + rx.cyl / 2;
}

export function toPowerVector(rx: SphCylAxis): PowerVector {
  if (rx.axis === null || Math.abs(rx.cyl) < EPS) return { M: rx.sph, J0: 0, J45: 0 };
  const h = rx.cyl / 2;
  return { M: rx.sph + h, J0: -h * Math.cos(rad(2 * rx.axis)), J45: -h * Math.sin(rad(2 * rx.axis)) };
}

export function transpose(rx: SphCylAxis): SphCylAxis {
  if (rx.axis === null || Math.abs(rx.cyl) < EPS) return { sph: rx.sph, cyl: 0, axis: null };
  return { sph: rx.sph + rx.cyl, cyl: -rx.cyl, axis: normalizeAxis(rx.axis + 90) };
}

export function fromPowerVector(pv: PowerVector, convention: "minus" | "plus" = "minus"): SphCylAxis {
  const j = Math.hypot(pv.J0, pv.J45);
  if (j < EPS / 2) return { sph: pv.M, cyl: 0, axis: null };
  const cyl = -2 * j;
  const minus: SphCylAxis = { sph: pv.M - cyl / 2, cyl, axis: doubledUnitToAxis(pv.J0, pv.J45) };
  return convention === "minus" ? minus : transpose(minus);
}

export function powerInMeridian(pv: PowerVector, thetaDeg: number): number {
  return pv.M + pv.J0 * Math.cos(rad(2 * thetaDeg)) + pv.J45 * Math.sin(rad(2 * thetaDeg));
}

export function rxPowerInMeridian(rx: SphCylAxis, thetaDeg: number): number {
  if (rx.axis === null) return rx.sph;
  return rx.sph + rx.cyl * Math.sin(rad(thetaDeg - rx.axis)) ** 2;
}

export function mirrorPowerVector(pv: PowerVector): PowerVector {
  return { M: pv.M, J0: pv.J0, J45: -pv.J45 };
}

export function roundToStep(v: number, step = 0.25): number {
  return Math.round(v / step) * step;
}

export function formatDiopters(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toFixed(digits);
  // a value that rounds to zero carries no sign: "0.00 D", never "−0.00 D"
  if (Number(s) === 0) return `${s} D`;
  return `${v < 0 ? "−" : "+"}${s} D`;
}
