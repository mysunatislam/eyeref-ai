/**
 * Focusing on the light. The person looks at the phone's light about a metre away, and an eye that can
 * bring it into focus does so: it reads more myopic than it is, by however much it focused. This module
 * works out what a capture says about each eye's own (relaxed) refraction once that is allowed for.
 * Twin of backend/eyeref/inference/focus.py.
 *
 * The model, for both eyes at once, since the eyes focus together (by the same amount):
 *
 *   light    F = −1/d               the refraction whose far point is the light, d metres away
 *   demand   D_e = M_e − F          what eye e must focus to see the light (below 0: out of its reach)
 *   drive    D* = the smallest demand that is not below 0, or 0 when the light is beyond both eyes
 *            (the eyes clear whichever eye needs least; a more hyperopic fellow eye stays blurred)
 *   focus    A = min(amplitude(age), g · D*), with g uniform over `focusResponse`: how fully the eyes
 *            follow the light. The default, 0 to 1, assumes no more than optics allows (an eye may not
 *            focus at all, or all the way); stage 1's capture with no lens measures what people do.
 *   reading  r_e ~ N(M_e − A, s_e²), or with no crescent, M_e − A + N(0, s_e²) inside the dead zone
 *
 * The posterior is computed on a grid over (M_OD, M_OS), averaged over g. Two priors answer two questions:
 *   - what this capture shows about an eye: no prior on a measured eye, so a clear reading is not pulled
 *     toward the population, while an eye with no reading follows its fellow through the population's
 *     correlation between eyes (it may still be the one the eyes focused for);
 *   - how likely each screening class is: the population's prior on each eye, as the dead zone has always
 *     used, so the probabilities stay calibrated where the reading cannot decide. With both eyes measured
 *     the priors are independent: the correlation between eyes is a normal distribution's, whose thin
 *     tails would pull an anisometropic pair together, so it is used only to stand in for a missing eye.
 */
import {
  ACCOMMODATION_AMPLITUDE_D,
  normalCdf,
  type ClassProbabilities,
  type ScreeningThresholds,
} from "../optics/classification";
import type { AgeGroup, EyeSide } from "../types";

/** What one eye's frames measured: a power with its SD, a dead-zone interval, or nothing. */
export type EyeReading =
  | { kind: "reading"; meanD: number; sdD: number }
  | { kind: "interval"; loD: number; hiD: number; sdD: number }
  | { kind: "none" };

export interface FocusConfig {
  /** the share of its demand an eye focuses, uniform over this range */
  focusResponse: [number, number];
  /** nodes of the midpoint rule over the focus response */
  responseNodes: number;
  /** grid step (D) */
  gridStepD: number;
  priorMeanD: number;
  priorSdD: number;
  /** correlation between a person's two eyes in the population */
  eyeCorrelation: number;
  /** focusing by this much (D) or more counts as focusing on the light */
  focusingD: number;
}

export const DEFAULT_FOCUS: FocusConfig = {
  focusResponse: [0, 1],
  responseNodes: 11,
  gridStepD: 0.05,
  priorMeanD: -0.5,
  priorSdD: 2.0,
  eyeCorrelation: 0.95,
  focusingD: 0.25,
};

export interface EyeFocus {
  /** the eye's own refraction (D) as this capture shows it, allowing for focusing: median and 95% interval */
  medianD: number;
  ci95: [number, number];
  /** each screening class's probability, with the population's prior */
  classProbabilities: ClassProbabilities;
}

export interface FocusPosterior {
  /** F = −1/d (D) */
  lightD: number;
  amplitudeD: number;
  focusResponse: [number, number];
  /** the probability that the eyes focused on the light by `focusingD` or more */
  pFocusing: number;
  /** the expected amount they focused (D) */
  meanFocusD: number;
  eyes: Record<EyeSide, EyeFocus | null>;
}

const GRID_LIMIT_D = 30;
/** the likelihood is tabulated this finely and read back by linear interpolation */
const TABLE_STEP_D = 0.01;

function likelihood(r: EyeReading): ((y: number) => number) | null {
  if (r.kind === "reading") {
    const k = 1 / (2 * r.sdD * r.sdD);
    return (y) => Math.exp(-((r.meanD - y) ** 2) * k);
  }
  if (r.kind === "interval") return (y) => normalCdf((r.hiD - y) / r.sdD) - normalCdf((r.loD - y) / r.sdD);
  return null;
}

/** A likelihood tabulated over [y0, y1], read back by linear interpolation and held flat past the ends. */
function tabulate(f: (y: number) => number, y0: number, y1: number): (y: number) => number {
  const m = Math.ceil((y1 - y0) / TABLE_STEP_D) + 1;
  const v = new Float64Array(m);
  for (let i = 0; i < m; i++) v[i] = f(y0 + i * TABLE_STEP_D);
  return (y) => {
    const t = (y - y0) / TABLE_STEP_D;
    if (t <= 0) return v[0]!;
    if (t >= m - 1) return v[m - 1]!;
    const i = Math.floor(t);
    return v[i]! + (t - i) * (v[i + 1]! - v[i]!);
  };
}

function span(r: EyeReading, amplitude: number): [number, number] | null {
  if (r.kind === "reading") return [r.meanD - 6 * r.sdD, r.meanD + amplitude + 6 * r.sdD];
  if (r.kind === "interval") return [r.loD - 6 * r.sdD, r.hiD + amplitude + 6 * r.sdD];
  return null;
}

/** Summaries of a grid marginal, each cell's mass spread evenly across it. */
function summarise(xs: number[], p: Float64Array, h: number) {
  let total = 0;
  for (const v of p) total += v;
  const below = (x: number) => {
    let m = 0;
    for (let i = 0; i < xs.length; i++) {
      const a = xs[i]! - h / 2;
      if (x >= a + h) m += p[i]!;
      else if (x > a) m += (p[i]! * (x - a)) / h;
    }
    return m / total;
  };
  const quantile = (q: number) => {
    const target = q * total;
    let c = 0;
    for (let i = 0; i < xs.length; i++) {
      if (c + p[i]! >= target && p[i]! > 0) return xs[i]! - h / 2 + (h * (target - c)) / p[i]!;
      c += p[i]!;
    }
    return xs[xs.length - 1]! + h / 2;
  };
  return { below, quantile };
}

/**
 * What a capture says about each eye's own refraction, allowing for the eyes focusing on the light. Null
 * when neither eye measured anything.
 */
export function focusPosterior(
  readings: Record<EyeSide, EyeReading>,
  ageGroup: AgeGroup,
  workingDistanceM: number,
  thresholds: ScreeningThresholds,
  cfg: FocusConfig = DEFAULT_FOCUS,
): FocusPosterior | null {
  const lOD = likelihood(readings.OD);
  const lOS = likelihood(readings.OS);
  if (!lOD && !lOS) return null;
  const amplitude = ACCOMMODATION_AMPLITUDE_D[ageGroup] ?? ACCOMMODATION_AMPLITUDE_D.unknown;
  const F = -1 / workingDistanceM;
  const { priorMeanD: mu, priorSdD: sd, eyeCorrelation: rho, gridStepD: h } = cfg;

  // one grid for both eyes, wide enough for each reading plus all the focusing it could hide
  const spans = [span(readings.OD, amplitude), span(readings.OS, amplitude)];
  if (spans.some((s) => s === null)) spans.push([mu - 4 * sd, mu + 4 * sd]);
  const lo = Math.max(-GRID_LIMIT_D, Math.min(...spans.filter((s) => s !== null).map((s) => s![0])));
  const hi = Math.min(GRID_LIMIT_D, Math.max(...spans.filter((s) => s !== null).map((s) => s![1])));
  const i0 = Math.floor(lo / h);
  const n = Math.ceil(hi / h) - i0 + 1;
  const xs = Array.from({ length: n }, (_, i) => (i0 + i) * h);

  const K = cfg.responseNodes;
  const [g0, g1] = cfg.focusResponse;
  const gs = Array.from({ length: K }, (_, k) => g0 + ((k + 0.5) * (g1 - g0)) / K);
  const one = () => 1;
  // focusing lowers a reading by up to the amplitude, so the likelihoods are read down to that far below the grid
  const fOD = lOD ? tabulate(lOD, xs[0]! - amplitude, xs[n - 1]!) : one;
  const fOS = lOS ? tabulate(lOS, xs[0]! - amplitude, xs[n - 1]!) : one;
  // with no focusing the likelihood factorises, which covers every cell where the light is out of reach
  const restOD = xs.map((x) => fOD(x));
  const restOS = xs.map((x) => fOS(x));

  const marginal = xs.map((x) => Math.exp(-((x - mu) ** 2) / (2 * sd * sd)));
  const condMean = xs.map((x) => mu + rho * (x - mu));
  const condVar2 = 2 * sd * sd * (1 - rho * rho);

  const both = lOD !== null && lOS !== null;

  const popOD = new Float64Array(n);
  const popOS = new Float64Array(n);
  const seenOD = new Float64Array(n);
  const seenOS = new Float64Array(n);
  let z = 0;
  let focusing = 0;
  let focusSum = 0;
  for (let i = 0; i < n; i++) {
    const dOD = xs[i]! - F;
    for (let j = 0; j < n; j++) {
      const dOS = xs[j]! - F;
      const drive = dOD >= 0 ? (dOS >= 0 ? Math.min(dOD, dOS) : dOD) : dOS >= 0 ? dOS : 0;
      let L: number;
      let Lf = 0;
      let LA = 0;
      if (drive === 0) L = restOD[i]! * restOS[j]!;
      else {
        L = 0;
        for (let k = 0; k < K; k++) {
          const A = Math.min(amplitude, gs[k]! * drive);
          const l = fOD(xs[i]! - A) * fOS(xs[j]! - A);
          L += l;
          LA += l * A;
          if (A >= cfg.focusingD) Lf += l;
        }
        L /= K;
        LA /= K;
        Lf /= K;
      }
      if (L === 0) continue;
      // with one eye measured, the other follows it through the correlation between eyes: its normal
      // distribution given the measured eye
      const follow = both
        ? 1
        : lOD
          ? Math.exp(-((xs[j]! - condMean[i]!) ** 2) / condVar2)
          : Math.exp(-((xs[i]! - condMean[j]!) ** 2) / condVar2);
      // the population's prior: each eye's own with both measured, else the pair's (the same either way)
      const w = both ? marginal[i]! * marginal[j]! : (lOD ? marginal[i]! : marginal[j]!) * follow;
      const joint = L * w;
      popOD[i] = popOD[i]! + joint;
      popOS[j] = popOS[j]! + joint;
      z += joint;
      if (drive !== 0) {
        focusing += Lf * w;
        focusSum += LA * w;
      }
      // what the capture shows: flat on a measured eye (only a measured eye's is reported)
      seenOD[i] = seenOD[i]! + L * follow;
      seenOS[j] = seenOS[j]! + L * follow;
    }
  }

  const eye = (measured: boolean, seen: Float64Array, pop: Float64Array): EyeFocus | null => {
    if (!measured) return null;
    const s = summarise(xs, seen, h);
    const p = summarise(xs, pop, h);
    const myopia = p.below(thresholds.myopiaSe);
    const hyperopia = 1 - p.below(thresholds.hyperopiaSe);
    return {
      medianD: s.quantile(0.5),
      ci95: [s.quantile(0.025), s.quantile(0.975)],
      classProbabilities: { myopia, emmetropia: Math.max(0, 1 - myopia - hyperopia), hyperopia },
    };
  };
  return {
    lightD: F,
    amplitudeD: amplitude,
    focusResponse: [g0, g1],
    pFocusing: z > 0 ? focusing / z : 0,
    meanFocusD: z > 0 ? focusSum / z : 0,
    eyes: { OD: eye(lOD !== null, seenOD, popOD), OS: eye(lOS !== null, seenOS, popOS) },
  };
}
