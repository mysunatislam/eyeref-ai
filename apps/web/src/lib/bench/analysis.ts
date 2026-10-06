/**
 * Bench analysis: the stage 0 go/no-go criteria of docs/RESEARCH_PROTOCOL.md and the dead-zone gradient
 * gain of docs/DEVICE_CALIBRATION.md section 3, from a bench run's frames. Its twin is
 * backend/eyeref/research/bench_run.py, which gives the same report from the run's file.
 */
import { isUsable } from "../cv/quality";
import { PhysicsHeuristicEstimator } from "../inference/estimators";
import {
  crescentSideForDefocus,
  deadZoneHalfwidth,
  defocusRelativeToCamera,
  invertCrescent,
  type Side,
} from "../optics/photorefraction";
import type { DeviceProfile } from "../types";
import { benchGeometry, benchSteps, type BenchFrame, type BenchRun, type BenchStep } from "./run";

/** A step this close outside the predicted dead zone may show a crescent too thin to find: it is not judged. */
export const EDGE_MARGIN_D = 0.25;
/** A crescent this wide fills the pupil, and its width no longer says how much defocus there is. */
export const SATURATED_WIDTH = 0.92;

export const CRITERIA = {
  edgeToleranceD: 0.25,
  widthSlope: [0.8, 1.2] as [number, number],
  minWidthSteps: 3,
  minIcc: 0.9,
  minGainR: 0.9,
  maxGainResidualSd: 0.35,
  minGainLevels: 3,
};

export interface GainFit {
  /** half-widths of the dead zone per unit of normalised slope */
  gain: number;
  intercept: number;
  /** in half-widths */
  residualSd: number;
  n: number;
  r: number;
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function pearson(x: number[], y: number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  x.forEach((xi, i) => {
    sxy += (xi - mx) * (y[i]! - my);
    sxx += (xi - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  });
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Weighted least squares for y = a·x + b. */
function weightedLine(x: number[], y: number[], w: number[]): [number, number] | null {
  const W = w.reduce((a, b) => a + b, 0);
  const mx = x.reduce((a, xi, i) => a + w[i]! * xi, 0) / W;
  const my = y.reduce((a, yi, i) => a + w[i]! * yi, 0) / W;
  let sxy = 0;
  let sxx = 0;
  x.forEach((xi, i) => {
    sxy += w[i]! * (xi - mx) * (y[i]! - my);
    sxx += w[i]! * (xi - mx) ** 2;
  });
  if (!(sxx > 0)) return null;
  const a = sxy / sxx;
  return [a, my - a * mx];
}

/**
 * Twin of eyeref.calibration.gradient.fit_gradient_gain: fits (power − centre)/halfwidth = −gain·slope + b,
 * reweighting large residuals (Huber, 10 rounds). Null with fewer than 5 frames, or slopes that are all equal.
 */
export function fitGradientGain(gradients: number[], y: number[]): GainFit | null {
  const n = gradients.length;
  if (n < 5 || y.length !== n) return null;
  let w = new Array<number>(n).fill(1);
  let coef: [number, number] = [0, 0];
  for (let round = 0; round < 10; round++) {
    const next = weightedLine(gradients, y, w);
    if (!next) return null;
    coef = next;
    const r = y.map((yi, i) => yi - (coef[0] * gradients[i]! + coef[1]));
    const s = 1.4826 * median(r.map(Math.abs)) + 1e-9;
    w = r.map((ri) => Math.min(Math.max((1.345 * s) / Math.max(Math.abs(ri), 1e-9), 0), 1));
  }
  const resid = y.map((yi, i) => yi - (coef[0] * gradients[i]! + coef[1]));
  const mr = mean(resid);
  const sd = n > 2 ? Math.sqrt(resid.reduce((a, ri) => a + (ri - mr) ** 2, 0) / (n - 2)) : 0;
  return { gain: -coef[0], intercept: coef[1], residualSd: sd, n, r: pearson(gradients, y) };
}

/** Twin of eyeref.research.bench.icc_1_1: one-way random-effects ICC(1,1) of repeated values per group. */
export function icc11(groups: number[][]): number | null {
  const g = groups.filter((x) => x.length >= 2);
  if (g.length < 2) return null;
  const k = mean(g.map((x) => x.length));
  const all = g.flat();
  const grand = mean(all);
  const msb = g.reduce((a, x) => a + x.length * (mean(x) - grand) ** 2, 0) / (g.length - 1);
  const msw =
    g.reduce((a, x) => a + x.reduce((b, v) => b + (v - mean(x)) ** 2, 0), 0) / (all.length - g.length);
  const den = msb + (k - 1) * msw;
  return den > 0 ? (msb - msw) / den : null;
}

export interface Stat {
  mean: number;
  /** null with one value */
  sd: number | null;
  n: number;
}

function stat(v: number[]): Stat | null {
  if (!v.length) return null;
  const m = mean(v);
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)) : null;
  return { mean: m, sd, n: v.length };
}

/** Where a step's refraction lies against the predicted dead zone. */
export type Zone = "inside" | "edge" | "outside";

export interface StepSummary {
  step: BenchStep;
  zone: Zone;
  /** the side the model predicts: 1 on the light source's side, −1 opposite, 0 in the dead zone */
  expectedSide: Side;
  frames: number;
  /** frames with a pupil found and a quality grade of acceptable or better */
  usable: number;
  /** of the usable frames, the share showing a crescent */
  crescentShare: number | null;
  /** the side most of the usable frames with a crescent show; 0 when none does */
  side: Side;
  widthNorm: Stat | null;
  gradient: Stat | null;
  /** the crescent width inverted with the profile's geometry, unsaturated frames only (D) */
  inverted: Stat | null;
  /** the calibrated estimator's value (D) */
  power: Stat | null;
}

export interface Criterion {
  id: "complete" | "side" | "width" | "edges" | "icc" | "gain";
  label: string;
  pass: boolean;
  detail: string;
}

export interface BenchReport {
  simulated: boolean;
  deviceId: string;
  /** null when the profile has no light-source geometry, and nothing else is analysed */
  predicted: { centreD: number; halfwidthD: number; deadZoneD: [number, number] } | null;
  steps: StepSummary[];
  /** where the crescent stopped being seen, half-way between steps (D) */
  observedEdgesD: [number | null, number | null] | null;
  widthFit: { slope: number; intercept: number; steps: number } | null;
  /** with the frames it was fitted to: [slope, (refraction − centre)/halfwidth] */
  gain: (GainFit & { levels: number; points: [number, number][] }) | null;
  icc: number | null;
  criteria: Criterion[];
  go: boolean;
  /** the profile with the fitted gain, offered only on go */
  calibrated: DeviceProfile | null;
}

const usableFrame = (f: BenchFrame) => f.record.features.pupil !== null && isUsable(f.record.quality);

function majoritySide(frames: BenchFrame[]): Side {
  let plus = 0;
  let minus = 0;
  for (const f of frames)
    if (f.record.features.crescentSide === 1) plus++;
    else if (f.record.features.crescentSide === -1) minus++;
  return plus > minus ? 1 : minus > plus ? -1 : 0;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** The device profile with a gain measured on the bench. */
export function calibratedProfile(device: DeviceProfile, fit: GainFit, when: Date): DeviceProfile {
  return {
    ...device,
    gradientGain: round(fit.gain, 3),
    gradientRelSd: round(fit.residualSd, 3),
    calibrationVersion: `bench-${when.toISOString().slice(0, 10)}`,
  };
}

/**
 * The phone's custom profiles with the calibrated one in place of the profile it was measured from, or
 * added if that profile has been deleted since.
 */
export function withCalibratedDevice(devices: DeviceProfile[], calibrated: DeviceProfile): DeviceProfile[] {
  const profile = {
    ...calibrated,
    notes: `Flash offset measured with a ruler. Gradient gain from a bench run (${calibrated.calibrationVersion}).`,
  };
  return devices.some((d) => d.id === profile.id)
    ? devices.map((d) => (d.id === profile.id ? profile : d))
    : [...devices, profile];
}

const f2 = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

export function analyseBench(run: BenchRun): BenchReport {
  const { device, setup } = run;
  const g = benchGeometry(device, setup);
  const empty = (why: string): BenchReport => ({
    simulated: run.simulated,
    deviceId: device.id,
    predicted: null,
    steps: [],
    observedEdgesD: null,
    widthFit: null,
    gain: null,
    icc: null,
    criteria: [{ id: "complete", label: "Light-source geometry", pass: false, detail: why }],
    go: false,
    calibrated: null,
  });
  if (!g) return empty("This profile has no light-source position, so there is nothing to check it against.");

  const centre = -1 / g.workingDistanceM;
  const half = deadZoneHalfwidth(g);
  const [lo, hi] = [centre - half, centre + half];
  const zoneOf = (R: number): Zone =>
    R >= lo && R <= hi ? "inside" : R >= lo - EDGE_MARGIN_D && R <= hi + EDGE_MARGIN_D ? "edge" : "outside";

  const byStep = new Map<string, BenchFrame[]>();
  const keyOf = (lensD: number, rotationDeg: number) => `${lensD}|${rotationDeg}`;
  for (const f of run.frames) {
    const k = keyOf(f.lensD, f.rotationDeg);
    byStep.set(k, [...(byStep.get(k) ?? []), f]);
  }

  // the gain, from the usable frames without a crescent at steps inside the predicted dead zone
  const gx: number[] = [];
  const gy: number[] = [];
  const gainLevels = new Set<number>();
  for (const f of run.frames) {
    if (zoneOf(f.refractionD) !== "inside" || !usableFrame(f) || f.record.features.crescentPresent) continue;
    gx.push(f.record.features.gradientAlongSource);
    gy.push((f.refractionD - centre) / half);
    gainLevels.add(f.refractionD);
  }
  const fit = fitGradientGain(gx, gy);
  const gain = fit && {
    ...fit,
    levels: gainLevels.size,
    points: gx.map((x, i): [number, number] => [x, gy[i]!]),
  };

  // every value is the estimator's, with the fitted gain when there is one
  const estimator = new PhysicsHeuristicEstimator();
  const profile = fit ? { ...device, gradientGain: fit.gain, gradientRelSd: fit.residualSd } : device;
  const powerOf = (f: BenchFrame) =>
    estimator.estimate(f.record.features, f.record.metadata, profile).powerD ?? null;

  const powersByStep: number[][] = [];
  const steps: StepSummary[] = benchSteps(setup).map((step) => {
    const frames = byStep.get(keyOf(step.lensD, step.rotationDeg)) ?? [];
    const usable = frames.filter(usableFrame);
    const withCrescent = usable.filter((f) => f.record.features.crescentPresent);
    const inverted = withCrescent
      .filter((f) => f.record.features.crescentWidthNorm < SATURATED_WIDTH)
      .map((f) =>
        invertCrescent(
          f.record.features.crescentWidthNorm * g.pupilDiameterM,
          f.record.features.crescentSide,
          g,
        ),
      )
      .filter((v): v is number => v !== null);
    const powers = usable.map(powerOf).filter((v): v is number => v !== null);
    powersByStep.push(powers);
    const zone = zoneOf(step.refractionD);
    return {
      step,
      zone,
      expectedSide:
        zone === "inside"
          ? 0
          : crescentSideForDefocus(defocusRelativeToCamera(step.refractionD, g.workingDistanceM)),
      frames: frames.length,
      usable: usable.length,
      crescentShare: usable.length ? withCrescent.length / usable.length : null,
      side: majoritySide(withCrescent),
      widthNorm: stat(withCrescent.map((f) => f.record.features.crescentWidthNorm)),
      gradient: stat(usable.map((f) => f.record.features.gradientAlongSource)),
      inverted: stat(inverted),
      power: stat(powers),
    };
  });

  const criteria: Criterion[] = [];

  // 0. every step has frames to judge
  const missing = steps.filter((s) => s.usable === 0);
  criteria.push({
    id: "complete",
    label: "Every step captured",
    pass: missing.length === 0,
    detail: missing.length
      ? `${missing.length} of ${steps.length} steps have no usable frame: ${missing
          .map((s) => `${f2(s.step.lensD)} D at ${s.step.rotationDeg}°`)
          .join(", ")}.`
      : `All ${steps.length} steps have usable frames.`,
  });

  // 1. the crescent is on the predicted side at every step clear of the dead zone
  const judged = steps.filter((s) => s.zone === "outside" && s.usable > 0);
  const wrong = judged.filter((s) => !(s.crescentShare! > 0.5 && s.side === s.expectedSide));
  const myopic = judged.some((s) => s.step.refractionD < lo);
  const hyperopic = judged.some((s) => s.step.refractionD > hi);
  // a whole rotation on the wrong side points at the geometry, not at the frames
  const reversed = setup.rotationsDeg.filter((rot) => {
    const at = judged.filter((s) => s.step.rotationDeg === rot);
    return at.length > 0 && at.every((s) => s.crescentShare! > 0.5 && s.side === -s.expectedSide);
  });
  const why =
    reversed.length && reversed.length === setup.rotationsDeg.length
      ? " Every step shows it on the opposite side: check the sign of the measured flash position first. If that is right, the side convention needs the change stage 0 of the research protocol describes."
      : reversed.length
        ? ` At ${reversed.map((r) => `${r}°`).join(" and ")} every step shows it on the opposite side, so the frames at that rotation are not turned the way the app assumes.`
        : "";
  criteria.push({
    id: "side",
    label: "Crescent on the predicted side",
    pass: myopic && hyperopic && wrong.length === 0,
    detail: !(myopic && hyperopic)
      ? `Needs usable steps more than ${EDGE_MARGIN_D} D beyond both edges of the predicted dead zone.`
      : wrong.length
        ? `${wrong.length} of ${judged.length} steps clear of the dead zone show no crescent or one on the wrong side: ${wrong
            .map((s) => `${f2(s.step.lensD)} D at ${s.step.rotationDeg}°`)
            .join(", ")}.${why}`
        : `All ${judged.length} steps clear of the dead zone show it on the predicted side.`,
  });

  // 2. the crescent width, inverted with the profile's geometry, follows the refraction one for one
  const widthSteps = steps.filter((s) => s.zone === "outside" && s.inverted);
  let widthFit: BenchReport["widthFit"] = null;
  if (widthSteps.length >= 2) {
    const line = weightedLine(
      widthSteps.map((s) => s.step.refractionD),
      widthSteps.map((s) => s.inverted!.mean),
      widthSteps.map(() => 1),
    );
    if (line) widthFit = { slope: line[0], intercept: line[1], steps: widthSteps.length };
  }
  const [slopeLo, slopeHi] = CRITERIA.widthSlope;
  criteria.push({
    id: "width",
    label: "Crescent width matches the model",
    pass:
      !!widthFit &&
      widthFit.steps >= CRITERIA.minWidthSteps &&
      widthFit.slope >= slopeLo &&
      widthFit.slope <= slopeHi,
    detail:
      !widthFit || widthFit.steps < CRITERIA.minWidthSteps
        ? `Needs at least ${CRITERIA.minWidthSteps} steps clear of the dead zone with an unsaturated crescent.`
        : `Measured against induced refraction, the slope is ${widthFit.slope.toFixed(2)} over ${widthFit.steps} steps (${slopeLo} to ${slopeHi} passes). A slope away from 1 means the flash position or the distance is off by that ratio.`,
  });

  // 3. the crescent disappears where the model says
  const levels = [...new Set(steps.map((s) => s.step.refractionD))].sort((a, b) => a - b);
  const absentAt = new Map<number, boolean>();
  for (const R of levels) {
    const usable = steps
      .filter((s) => s.step.refractionD === R)
      .flatMap((s) => (byStep.get(keyOf(s.step.lensD, s.step.rotationDeg)) ?? []).filter(usableFrame));
    if (usable.length)
      absentAt.set(R, usable.filter((f) => !f.record.features.crescentPresent).length / usable.length > 0.5);
  }
  const seen = levels.filter((R) => absentAt.has(R));
  const absent = seen.filter((R) => absentAt.get(R));
  let observedEdgesD: BenchReport["observedEdgesD"] = null;
  if (absent.length) {
    const first = absent[0]!;
    const last = absent[absent.length - 1]!;
    const below = seen.filter((R) => R < first).pop();
    const above = seen.find((R) => R > last);
    observedEdgesD = [
      below === undefined ? null : (below + first) / 2,
      above === undefined ? null : (last + above) / 2,
    ];
  }
  const edgeOk = (v: number | null, p: number) =>
    v !== null && Math.abs(v - p) <= CRITERIA.edgeToleranceD + 1e-9;
  criteria.push({
    id: "edges",
    label: "Dead zone where predicted",
    pass: !!observedEdgesD && edgeOk(observedEdgesD[0], lo) && edgeOk(observedEdgesD[1], hi),
    detail: !observedEdgesD
      ? "The crescent was seen at every step, so there is no dead zone to compare."
      : observedEdgesD[0] === null || observedEdgesD[1] === null
        ? "The lenses do not reach past both edges of the dead zone."
        : `Observed ${f2(observedEdgesD[0])} to ${f2(observedEdgesD[1])} D, predicted ${f2(lo)} to ${f2(hi)} D (within ${CRITERIA.edgeToleranceD} D passes).`,
  });

  // 4. repeated frames agree
  const icc = icc11(powersByStep);
  criteria.push({
    id: "icc",
    label: "Repeated frames agree",
    pass: icc !== null && icc >= CRITERIA.minIcc,
    detail:
      icc === null
        ? "Needs at least two steps with two or more values each."
        : `ICC(1,1) of the values from repeated frames is ${icc.toFixed(3)} (${CRITERIA.minIcc} or more passes).`,
  });

  // 5. the gain inside the dead zone
  const gainOk =
    !!gain &&
    gain.gain > 0 &&
    Math.abs(gain.r) >= CRITERIA.minGainR &&
    gain.residualSd <= CRITERIA.maxGainResidualSd &&
    gain.levels >= CRITERIA.minGainLevels;
  criteria.push({
    id: "gain",
    label: "Gradient gain fits",
    pass: gainOk,
    detail: !gain
      ? "Needs at least 5 usable frames without a crescent at steps inside the predicted dead zone."
      : `Gain ${gain.gain.toFixed(2)}, r ${gain.r.toFixed(3)}, residual SD ${gain.residualSd.toFixed(2)} of a half-width, from ${gain.n} frames at ${gain.levels} refractions (needs a positive gain, |r| of ${CRITERIA.minGainR} or more, an SD of ${CRITERIA.maxGainResidualSd} or less, and ${CRITERIA.minGainLevels} refractions).`,
  });

  const go = criteria.every((c) => c.pass);
  return {
    simulated: run.simulated,
    deviceId: device.id,
    predicted: { centreD: centre, halfwidthD: half, deadZoneD: [lo, hi] },
    steps,
    observedEdgesD,
    widthFit,
    gain,
    icc,
    criteria,
    go,
    calibrated: go && fit ? calibratedProfile(device, fit, new Date(run.createdAt)) : null,
  };
}
