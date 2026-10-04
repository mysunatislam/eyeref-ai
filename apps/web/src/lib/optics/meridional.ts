/**
 * Bayesian multi-meridian fit of (M, J0, J45) - twin of backend/eyeref/optics/meridional.py.
 * P_i = M + J0 cos 2t_i + J45 sin 2t_i + e_i, prior N(0, diag(4^2, 0.35^2, 0.35^2)).
 */
import {
  circularAxisError,
  fromPowerVector,
  normalizeAxis,
  type PowerVector,
  type SphCylAxis,
} from "./powerVector";
import { createRng, gaussianPair } from "../random";

export const PRIOR_SD_M = 4.0;
export const PRIOR_SD_J = 0.35;

export interface MeridionalObservation {
  meridianDeg: number;
  powerD: number;
  sigmaD: number;
}

export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

export interface PowerVectorPosterior {
  mean: [number, number, number];
  cov: Mat3;
  nMeridians: number;
  distinctMeridians: number;
}

export function invert3(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error("singular matrix");
  const k = 1 / det;
  return [
    [A * k, -(b * i - c * h) * k, (b * f - c * e) * k],
    [B * k, (a * i - c * g) * k, -(a * f - c * d) * k],
    [C * k, -(a * h - b * g) * k, (a * e - b * d) * k],
  ];
}

export function countDistinctMeridians(thetas: number[], tolDeg = 15): number {
  const reps: number[] = [];
  for (const t of thetas)
    if (reps.every((r) => circularAxisError(t, r) > tolDeg)) reps.push(normalizeAxis(t));
  return reps.length;
}

export function fitPowerVector(
  obs: MeridionalObservation[],
  priorSdM = PRIOR_SD_M,
  priorSdJ = PRIOR_SD_J,
): PowerVectorPosterior {
  const prec: Mat3 = [
    [1 / priorSdM ** 2, 0, 0],
    [0, 1 / priorSdJ ** 2, 0],
    [0, 0, 1 / priorSdJ ** 2],
  ];
  const rhs = [0, 0, 0];
  for (const o of obs) {
    const t = (2 * o.meridianDeg * Math.PI) / 180;
    const row = [1, Math.cos(t), Math.sin(t)];
    const w = 1 / Math.max(o.sigmaD, 1e-3) ** 2;
    for (let r = 0; r < 3; r++) {
      rhs[r]! += w * row[r]! * o.powerD;
      for (let c = 0; c < 3; c++) prec[r]![c]! += w * row[r]! * row[c]!;
    }
  }
  const cov = invert3(prec);
  const mean = [0, 1, 2].map(
    (r) => cov[r]![0]! * rhs[0]! + cov[r]![1]! * rhs[1]! + cov[r]![2]! * rhs[2]!,
  ) as [number, number, number];
  return {
    mean,
    cov,
    nMeridians: obs.length,
    distinctMeridians: countDistinctMeridians(obs.map((o) => o.meridianDeg)),
  };
}

export function posteriorPowerVector(p: PowerVectorPosterior): PowerVector {
  return { M: p.mean[0], J0: p.mean[1], J45: p.mean[2] };
}

function cholesky3(m: Mat3): Mat3 {
  const L: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      L[i]![j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j]![j]!;
    }
  }
  return L;
}

export interface RefractionDistribution {
  point: SphCylAxis;
  sphCi95: [number, number];
  cylCi95: [number, number];
  seCi95: [number, number];
  axisSdDeg: number;
  pCylGe: Record<string, number>;
  sphSamples: number[];
  cylSamples: number[];
  axisSamples: number[];
}

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]!;

export function sampleRefraction(post: PowerVectorPosterior, n = 3000, seed = 7): RefractionDistribution {
  const rng = createRng(seed);
  const L = cholesky3(post.cov);
  const sph: number[] = [];
  const cyl: number[] = [];
  const axis: number[] = [];
  const M: number[] = [];
  let cs = 0;
  let ss = 0;
  const pCyl: Record<string, number> = { "0.5": 0, "0.75": 0, "1": 0, "1.5": 0 };
  for (let k = 0; k < n; k++) {
    const [z0, z1] = gaussianPair(rng);
    const [z2] = gaussianPair(rng);
    const z = [z0, z1, z2];
    const s = [0, 1, 2].map((i) => post.mean[i]! + L[i]![0]! * z[0]! + L[i]![1]! * z[1]! + L[i]![2]! * z[2]!);
    const j = Math.hypot(s[1]!, s[2]!);
    const twoA = Math.atan2(s[2]!, s[1]!);
    M.push(s[0]!);
    sph.push(s[0]! + j);
    cyl.push(-2 * j);
    axis.push(normalizeAxis((twoA * 90) / Math.PI));
    cs += Math.cos(twoA);
    ss += Math.sin(twoA);
    for (const t of Object.keys(pCyl)) if (2 * j >= Number(t)) pCyl[t]! += 1;
  }
  for (const t of Object.keys(pCyl)) pCyl[t]! /= n;
  const R = Math.min(Math.max(Math.hypot(cs / n, ss / n), 1e-12), 1);
  const axisSd = (Math.sqrt(-2 * Math.log(R)) * 180) / Math.PI / 2;
  const srt = (a: number[]) => [...a].sort((x, y) => x - y);
  const [sS, cS, mS] = [srt(sph), srt(cyl), srt(M)];
  return {
    point: fromPowerVector(posteriorPowerVector(post)),
    sphCi95: [pct(sS, 2.5), pct(sS, 97.5)],
    cylCi95: [pct(cS, 2.5), pct(cS, 97.5)],
    seCi95: [pct(mS, 2.5), pct(mS, 97.5)],
    axisSdDeg: axisSd,
    pCylGe: pCyl,
    sphSamples: sph.slice(0, 1500),
    cylSamples: cyl.slice(0, 1500),
    axisSamples: axis.slice(0, 1500),
  };
}
