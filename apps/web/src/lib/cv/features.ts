/** Interpretable photorefraction features - same definitions as backend/eyeref/cv/features.py. */
import { imageVectorToTabo } from "../optics/powerVector";
import type { Circle, PhotorefractionFeatures } from "../types";
import { lumaMap, redChromaMap, redMap, type RgbaImage } from "./image";
import { segmentEye, type EyeSegmentation } from "./segmentation";

export const EXTRACTOR_VERSION = "pr-features-1.0.0";
export const HVID_MM = 11.7;

export function circularSegmentAreaFraction(hNorm: number): number {
  const h = Math.min(Math.max(hNorm, 0), 1) * 2;
  if (h <= 0) return 0;
  if (h >= 2) return 1;
  return (Math.acos(1 - h) - (1 - h) * Math.sqrt(2 * h - h * h)) / Math.PI;
}

export function segmentHeightFromAreaFraction(frac: number): number {
  const f = Math.min(Math.max(frac, 0), 1);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (circularSegmentAreaFraction(mid) < f) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function emptyFeatures(sourceAngle: number | null): PhotorefractionFeatures {
  return {
    pupil: null,
    iris: null,
    glint: null,
    pupilDiameterMm: null,
    pupilToIrisRatio: null,
    pupilEllipseEccentricity: null,
    reflexMeanLuma: null,
    reflexMeanRgb: null,
    reflexRedChroma: null,
    reflexEntropy: null,
    crescentPresent: false,
    crescentAreaFraction: 0,
    crescentWidthNorm: 0,
    crescentWidthMm: 0,
    crescentSide: 0,
    crescentCentroidOffsetNorm: 0,
    crescentOrientationDeg: null,
    crescentContrast: 1,
    crescentSeparability: 0,
    gradientAlongSource: 0,
    gradientPerpendicular: 0,
    dominantGradientDeg: null,
    asymmetryIndex: 0,
    profileAlongSource: [],
    profilePerpendicular: [],
    profilePolyCoeffs: [],
    radialProfile: [],
    glintOffsetNorm: null,
    sourceAngleImageDeg: sourceAngle,
    extractorVersion: EXTRACTOR_VERSION,
  };
}

function profile(
  red: Float32Array,
  w: number,
  h: number,
  c: Circle,
  ux: number,
  uy: number,
  n = 21,
): (number | null)[] {
  const out: (number | null)[] = [];
  for (let k = 0; k < n; k++) {
    const t = -0.9 + (1.8 * k) / (n - 1);
    const xi = Math.round(c.cx + t * c.r * ux);
    const yi = Math.round(c.cy + t * c.r * uy);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) {
      out.push(null);
      continue;
    }
    let s = 0;
    let m = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = xi + dx;
        const y = yi + dy;
        if (x >= 0 && y >= 0 && x < w && y < h) {
          s += red[y * w + x]!;
          m++;
        }
      }
    out.push(s / m);
  }
  return out;
}

/** Least-squares polynomial fit (degree 3) returning coefficients c0..c3. */
export function polyfit3(t: number[], y: number[]): number[] {
  const deg = 3;
  const A: number[][] = Array.from({ length: deg + 1 }, () => new Array(deg + 2).fill(0));
  for (let i = 0; i < t.length; i++) {
    const p = [1, t[i]!, t[i]! ** 2, t[i]! ** 3];
    for (let r = 0; r <= deg; r++) {
      for (let c = 0; c <= deg; c++) A[r]![c]! += p[r]! * p[c]!;
      A[r]![deg + 1]! += p[r]! * y[i]!;
    }
  }
  for (let col = 0; col <= deg; col++) {
    let piv = col;
    for (let r = col + 1; r <= deg; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    const d = A[col]![col]! || 1e-12;
    for (let c = col; c <= deg + 1; c++) A[col]![c]! /= d;
    for (let r = 0; r <= deg; r++) {
      if (r === col) continue;
      const f = A[r]![col]!;
      for (let c = col; c <= deg + 1; c++) A[r]![c]! -= f * A[col]![c]!;
    }
  }
  return A.map((row) => row[deg + 1]!);
}

export function extractFeatures(
  img: RgbaImage,
  sourceAngleImageDeg: number | null,
  iris: Circle,
  flash = true,
  irisDiameterMm = HVID_MM,
  seg?: EyeSegmentation,
): { features: PhotorefractionFeatures; segmentation: EyeSegmentation } {
  const s = seg ?? segmentEye(img, iris, flash);
  const f = emptyFeatures(sourceAngleImageDeg);
  f.iris = s.iris;
  f.glint = s.glint;
  if (!s.pupil) return { features: f, segmentation: s };
  const P = s.pupil;
  const { width: w, height: h } = img;
  f.pupil = P;
  f.pupilToIrisRatio = P.r / s.iris.r;
  f.pupilDiameterMm = f.pupilToIrisRatio * irisDiameterMm;

  const red = redMap(img);
  const L = lumaMap(img);
  const chroma = redChromaMap(img);
  const inner: number[] = [];
  for (let i = 0; i < w * h; i++) if (s.pupilMask[i] && !s.glintMask[i]) inner.push(i);
  if (inner.length < 20) return { features: f, segmentation: s };

  let sumR = 0,
    sumL = 0,
    sumC = 0;
  const rgb = [0, 0, 0];
  const hist = new Array(32).fill(0);
  for (const i of inner) {
    sumR += red[i]!;
    sumL += L[i]!;
    sumC += chroma[i]!;
    for (let k = 0; k < 3; k++) rgb[k]! += img.data[4 * i + k]!;
    hist[Math.min(31, Math.floor(red[i]! * 32))]++;
  }
  const n = inner.length;
  const meanV = sumR / n;
  f.reflexMeanLuma = sumL / n;
  f.reflexRedChroma = sumC / n;
  f.reflexMeanRgb = [rgb[0]! / n, rgb[1]! / n, rgb[2]! / n];
  f.reflexEntropy = -hist.filter((c) => c > 0).reduce((a, c) => a + (c / n) * Math.log2(c / n), 0);

  // pupil ellipse eccentricity from second moments
  let mx = 0,
    my = 0,
    cntP = 0;
  for (let i = 0; i < w * h; i++)
    if (s.pupilMask[i]) {
      mx += i % w;
      my += Math.floor(i / w);
      cntP++;
    }
  mx /= cntP;
  my /= cntP;
  let cxx = 0,
    cyy = 0,
    cxy = 0;
  for (let i = 0; i < w * h; i++)
    if (s.pupilMask[i]) {
      const dx = (i % w) - mx;
      const dy = Math.floor(i / w) - my;
      cxx += dx * dx;
      cyy += dy * dy;
      cxy += dx * dy;
    }
  const tr = (cxx + cyy) / cntP;
  const det = (cxx * cyy - cxy * cxy) / cntP ** 2;
  const disc = Math.sqrt(Math.max((tr * tr) / 4 - det, 0));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  f.pupilEllipseEccentricity = Math.sqrt(Math.max(0, 1 - l2 / Math.max(l1, 1e-9)));

  if (s.glint) f.glintOffsetNorm = [(s.glint[0] - P.cx) / P.r, (s.glint[1] - P.cy) / P.r];

  const nx = (i: number) => ((i % w) - P.cx) / P.r;
  const ny = (i: number) => (Math.floor(i / w) - P.cy) / P.r;
  let gx = 0,
    gy = 0;
  for (const i of inner) {
    const wv = red[i]! - meanV;
    gx += wv * nx(i);
    gy += wv * ny(i);
  }
  if (Math.hypot(gx, gy) > 1e-9) f.dominantGradientDeg = imageVectorToTabo(gx, gy);

  f.radialProfile = [];
  for (let b = 0; b < 8; b++) {
    let s2 = 0,
      c2 = 0;
    for (const i of inner) {
      const rn = Math.hypot(nx(i), ny(i));
      if (rn >= b / 8 && rn < (b + 1) / 8) {
        s2 += red[i]!;
        c2++;
      }
    }
    f.radialProfile.push(c2 ? s2 / c2 : null);
  }

  if (sourceAngleImageDeg === null) return { features: f, segmentation: s };
  const a = (sourceAngleImageDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = -Math.sin(a);

  // linear regression red ~ b0 + b1*proj + b2*perp
  let S00 = 0,
    S01 = 0,
    S02 = 0,
    S11 = 0,
    S12 = 0,
    S22 = 0,
    T0 = 0,
    T1 = 0,
    T2 = 0;
  let posS = 0,
    posN = 0,
    negS = 0,
    negN = 0;
  for (const i of inner) {
    const p = nx(i) * ux + ny(i) * uy;
    const q = -nx(i) * uy + ny(i) * ux;
    const v = red[i]!;
    S00 += 1;
    S01 += p;
    S02 += q;
    S11 += p * p;
    S12 += p * q;
    S22 += q * q;
    T0 += v;
    T1 += p * v;
    T2 += q * v;
    if (p > 0) {
      posS += v;
      posN++;
    } else if (p < 0) {
      negS += v;
      negN++;
    }
  }
  const M: number[][] = [
    [S00, S01, S02],
    [S01, S11, S12],
    [S02, S12, S22],
  ];
  const T = [T0, T1, T2];
  const d3 = (m: number[][]) =>
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const D = d3(M);
  if (Math.abs(D) > 1e-12) {
    const coef = [0, 1, 2].map((c) => d3(M.map((row, r) => row.map((v, k) => (k === c ? T[r]! : v)))) / D);
    f.gradientAlongSource = coef[1]! / Math.max(meanV, 1e-6);
    f.gradientPerpendicular = coef[2]! / Math.max(meanV, 1e-6);
  }
  if (posN && negN) f.asymmetryIndex = (posS / posN - negS / negN) / Math.max(meanV, 1e-6);

  f.profileAlongSource = profile(red, w, h, P, ux, uy);
  f.profilePerpendicular = profile(red, w, h, P, -uy, ux);
  const tt: number[] = [];
  const yy: number[] = [];
  f.profileAlongSource.forEach((v, k) => {
    if (v !== null) {
      tt.push(-0.9 + (1.8 * k) / 20);
      yy.push(v / Math.max(meanV, 1e-6));
    }
  });
  if (tt.length >= 5) f.profilePolyCoeffs = polyfit3(tt, yy);

  f.crescentSeparability = s.crescentEta;
  f.crescentContrast = s.crescentContrast;
  let cmN = 0,
    cmx = 0,
    cmy = 0,
    pmN = 0;
  for (let i = 0; i < w * h; i++) {
    if (s.pupilMask[i]) pmN++;
    if (s.crescentMask[i]) {
      cmN++;
      cmx += nx(i);
      cmy += ny(i);
    }
  }
  if (cmN > 0) {
    const frac = cmN / Math.max(pmN, 1);
    const cxn = cmx / cmN;
    const cyn = cmy / cmN;
    const along = cxn * ux + cyn * uy;
    f.crescentAreaFraction = frac;
    f.crescentCentroidOffsetNorm = along;
    f.crescentOrientationDeg = imageVectorToTabo(cxn, cyn);
    if (frac > 0.5) {
      let dN = 0,
        dx = 0,
        dy = 0;
      for (let i = 0; i < w * h; i++)
        if (s.pupilMask[i] && !s.crescentMask[i] && !s.glintMask[i]) {
          dN++;
          dx += nx(i);
          dy += ny(i);
        }
      if (dN > 5) {
        const dAlong = (dx / dN) * ux + (dy / dN) * uy;
        if (Math.abs(dAlong) > 0.25 && Math.abs(dAlong) >= 0.6 * Math.hypot(dx / dN, dy / dN)) {
          f.crescentPresent = true;
          f.crescentSide = dAlong > 0 ? -1 : 1;
          f.crescentWidthNorm = 1 - segmentHeightFromAreaFraction(1 - frac);
        }
      }
    } else if (Math.abs(along) > 0.25 && Math.abs(along) >= 0.6 * Math.hypot(cxn, cyn)) {
      f.crescentPresent = true;
      f.crescentSide = along > 0 ? 1 : -1;
      f.crescentWidthNorm = segmentHeightFromAreaFraction(frac);
    }
    if (f.crescentPresent) f.crescentWidthMm = f.crescentWidthNorm * (f.pupilDiameterMm ?? 0);
  }
  return { features: f, segmentation: s };
}
