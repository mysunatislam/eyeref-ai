/** Screening classification (twin of backend/eyeref/optics/classification.py). */
import type { AgeGroup, RefractiveClass } from "../types";

export interface ScreeningThresholds {
  myopiaSe: number;
  hyperopiaSe: number;
  astigmatismCyl: number;
  anisometropiaSe: number;
  highMyopiaSe: number;
  highHyperopiaSe: number;
}

const ADULT: ScreeningThresholds = {
  myopiaSe: -0.5,
  hyperopiaSe: 0.5,
  astigmatismCyl: 0.75,
  anisometropiaSe: 1.0,
  highMyopiaSe: -6,
  highHyperopiaSe: 5,
};

export function thresholdsForAge(age: AgeGroup): ScreeningThresholds {
  if (age === "child_3_7") return { ...ADULT, myopiaSe: -0.75, hyperopiaSe: 2.0, astigmatismCyl: 1.5 };
  if (age === "child_8_12") return { ...ADULT, myopiaSe: -0.5, hyperopiaSe: 1.5, astigmatismCyl: 1.0 };
  return ADULT;
}

/** Residual accommodation SD (D) for non-cycloplegic measurement, by age group. */
export const ACCOMMODATION_SD: Record<AgeGroup, number> = {
  child_3_7: 0.8,
  child_8_12: 0.65,
  teen: 0.5,
  adult_18_39: 0.35,
  adult_40_59: 0.2,
  adult_60_plus: 0.1,
  unknown: 0.5,
};

export function normalCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26 erf approximation (|err| < 1.5e-7)
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export type ClassProbabilities = Record<RefractiveClass, number>;

export function classProbabilities(mu: number, sd: number, t: ScreeningThresholds): ClassProbabilities {
  const s = Math.max(sd, 1e-6);
  const my = normalCdf((t.myopiaSe - mu) / s);
  const hy = 1 - normalCdf((t.hyperopiaSe - mu) / s);
  return { myopia: my, emmetropia: Math.max(0, 1 - my - hy), hyperopia: hy };
}

export function topClass(p: ClassProbabilities): { label: RefractiveClass; confidence: number } {
  const entries = Object.entries(p) as [RefractiveClass, number][];
  entries.sort((a, b) => b[1] - a[1]);
  return { label: entries[0]![0], confidence: entries[0]![1] };
}

export function truncatedPriorClassProbabilities(
  lo: number,
  hi: number,
  t: ScreeningThresholds,
  priorMean = -0.5,
  priorSd = 2.0,
): ClassProbabilities {
  const mass = (a: number, b: number) => {
    const A = Math.max(a, lo);
    const B = Math.min(b, hi);
    return B <= A ? 0 : normalCdf((B - priorMean) / priorSd) - normalCdf((A - priorMean) / priorSd);
  };
  const total = mass(lo, hi);
  if (total <= 0) return { myopia: 1 / 3, emmetropia: 1 / 3, hyperopia: 1 / 3 };
  return {
    myopia: mass(-Infinity, t.myopiaSe) / total,
    emmetropia: mass(t.myopiaSe, t.hyperopiaSe) / total,
    hyperopia: mass(t.hyperopiaSe, Infinity) / total,
  };
}

export function severityLabel(se: number, t: ScreeningThresholds): string {
  if (se <= t.highMyopiaSe) return "High myopia";
  if (se <= -3) return "Moderate myopia";
  if (se <= t.myopiaSe) return "Mild myopia";
  if (se >= t.highHyperopiaSe) return "High hyperopia";
  if (se >= 2) return "Moderate hyperopia";
  if (se >= t.hyperopiaSe) return "Mild hyperopia";
  return "No significant spherical error";
}

export function anisometropiaProbability(
  muA: number,
  sdA: number,
  muB: number,
  sdB: number,
  thr: number,
): number {
  const mu = muA - muB;
  const sd = Math.hypot(sdA, sdB);
  return 1 - (normalCdf((thr - mu) / sd) - normalCdf((-thr - mu) / sd));
}
