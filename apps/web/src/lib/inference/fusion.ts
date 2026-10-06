/**
 * Multi-frame + multi-meridian fusion, uncertainty and output gating.
 * Twin of backend/eyeref/inference/fusion.py - see that file for the error model.
 */
import {
  ACCOMMODATION_SD,
  anisometropiaProbability,
  classProbabilities,
  severityLabel,
  thresholdsForAge,
  topClass,
  truncatedPriorClassProbabilities,
  type ClassProbabilities,
  type ScreeningThresholds,
} from "../optics/classification";
import {
  countDistinctMeridians,
  fitPowerVector,
  posteriorPowerVector,
  sampleRefraction,
  type MeridionalObservation,
  type RefractionDistribution,
} from "../optics/meridional";
import { formatDiopters, normalizeAxis, powerInMeridian } from "../optics/powerVector";
import { isUsable } from "../cv/quality";
import type {
  AgeGroup,
  AssessmentReport,
  EyeResult,
  EyeSide,
  FocusSummary,
  FrameRecord,
  MeridianSummary,
  Provenance,
  QualityGrade,
  RefractiveClass,
} from "../types";
import { DEFAULT_FOCUS, focusPosterior, type EyeReading, type FocusPosterior } from "./focus";

export const APP_VERSION = "0.1.0";
export const RHO_SYSTEMATIC = 0.5;
export const MERIDIAN_BIN_DEG = 22.5;
export const INTERVAL_BOUND_SD = 0.35;

export const MEDICAL_DISCLAIMER =
  "Experimental research prototype. This is a screening estimate, not an eyeglass prescription, and it does not " +
  "replace a comprehensive eye examination. Abnormal red reflexes can indicate conditions unrelated to refractive " +
  "error. Sudden vision loss, eye pain, flashes, floaters or trauma require urgent professional assessment.";

export interface GatingConfig {
  minUsableFramesPerMeridian: number;
  maxSeCiHalfwidthQuantitative: number;
  minClassConfidenceScreening: number;
  astigmatismQuantificationEnabled: boolean;
  minDistinctMeridiansForCyl: number;
  maxCylCiWidth: number;
  maxAxisSdDeg: number;
  reflexAsymmetryRatio: number;
  calibrationSdUncalibrated: number;
  calibrationSdCalibrated: number;
  populationPriorMean: number;
  populationPriorSd: number;
  /** the share of what it needs that an eye focuses on the light, assumed uniform over this range */
  focusResponse: [number, number];
  /** correlation between a person's two eyes in the population (the focusing model's prior) */
  eyeCorrelation: number;
}

export const DEFAULT_GATING: GatingConfig = {
  minUsableFramesPerMeridian: 3,
  maxSeCiHalfwidthQuantitative: 1.0,
  minClassConfidenceScreening: 0.8,
  astigmatismQuantificationEnabled: false,
  minDistinctMeridiansForCyl: 3,
  maxCylCiWidth: 1.0,
  maxAxisSdDeg: 15,
  reflexAsymmetryRatio: 1.35,
  calibrationSdUncalibrated: 0.5,
  calibrationSdCalibrated: 0.2,
  populationPriorMean: -0.5,
  populationPriorSd: 2.0,
  focusResponse: [0, 1],
  eyeCorrelation: 0.95,
};

/** The focusing model's settings that the gating configuration carries. */
const focusConfig = (cfg: GatingConfig) => ({
  ...DEFAULT_FOCUS,
  focusResponse: cfg.focusResponse,
  priorMeanD: cfg.populationPriorMean,
  priorSdD: cfg.populationPriorSd,
  eyeCorrelation: cfg.eyeCorrelation,
});

const binMeridian = (m: number) =>
  normalizeAxis(Math.round(normalizeAxis(m) / MERIDIAN_BIN_DEG) * MERIDIAN_BIN_DEG);
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const robustSd = (a: number[]) => (a.length < 2 ? 0 : 1.4826 * median(a.map((v) => Math.abs(v - median(a)))));
const GRADE_ORDER: QualityGrade[] = ["excellent", "acceptable", "poor", "reject"];

function emptyEye(eye: EyeSide, frames: FrameRecord[], usable: FrameRecord[]): EyeResult {
  return {
    eye,
    outputLevel: "repeat",
    message: "",
    seD: null,
    seCi95: null,
    sphD: null,
    sphCi95: null,
    cylD: null,
    cylCi95: null,
    axisDeg: null,
    axisUncertaintyDeg: null,
    powerVector: null,
    powerVectorSd: null,
    refractiveClass: null,
    severity: null,
    classProbabilities: null,
    astigmatismStatus: "not_assessed",
    astigmatismProbability: null,
    confidence: null,
    qualityGrade: null,
    medianQuality: null,
    nFrames: frames.length,
    nUsableFrames: usable.length,
    meridians: [],
    reflexMeanLuma: null,
    deadZoneD: null,
    research: null,
    notes: [],
  };
}

/** What an eye's frames measured, before focusing on the light is allowed for. */
interface EyeMeasurement {
  /** filled with everything measured; the output fields are set by gateEye */
  res: EyeResult;
  /** already final: nothing usable was measured */
  done: boolean;
  t: ScreeningThresholds;
  reading: EyeReading;
  hasObs: boolean;
  nQuant: number;
  nIntervals: number;
  dist: RefractionDistribution | null;
  /** the class probabilities of the reading on its own, as if the eyes had not focused */
  readingProbs: ClassProbabilities | null;
  /** the 95% half-width of the reading on its own (D) */
  readingHalf: number | null;
  acc: number;
}

function measureEye(
  eye: EyeSide,
  frames: FrameRecord[],
  ageGroup: AgeGroup,
  calibrated: boolean,
  cfg: GatingConfig,
): EyeMeasurement {
  const t = thresholdsForAge(ageGroup);
  const acc = ACCOMMODATION_SD[ageGroup] ?? 0.5;
  const usable = frames.filter((f) => isUsable(f.quality) && f.estimate && f.estimate.meridianDeg !== null);
  const res = emptyEye(eye, frames, usable);
  const final = (): EyeMeasurement => ({
    res,
    done: true,
    t,
    reading: { kind: "none" },
    hasObs: false,
    nQuant: 0,
    nIntervals: 0,
    dist: null,
    readingProbs: null,
    readingHalf: null,
    acc,
  });
  if (frames.length) {
    res.medianQuality = median(frames.map((f) => f.quality.score));
    const grades = (usable.length ? usable : frames).map((f) => f.quality.grade);
    grades.sort((a, b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b));
    res.qualityGrade = grades[Math.floor(grades.length / 2)] ?? null;
  }
  const lum = usable.map((f) => f.features.reflexMeanLuma).filter((v): v is number => v !== null && v > 0);
  res.reflexMeanLuma = lum.length ? median(lum) : null;
  if (!usable.length) {
    res.message = "No frame passed quality control. Repeat the measurement (see capture guidance).";
    return final();
  }
  const groups = new Map<number, FrameRecord[]>();
  for (const f of usable) {
    const k = binMeridian(f.estimate!.meridianDeg!);
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const obs: MeridionalObservation[] = [];
  const intervals: [number, number, number][] = [];
  for (const [m, fs] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const q = fs.map((f) => f.estimate!).filter((e) => e.status === "quantitative" && e.powerD !== null);
    const iv = fs.map((f) => f.estimate!).filter((e) => e.status === "interval" && e.intervalD);
    const s: MeridianSummary = {
      meridianDeg: m,
      nFrames: fs.length,
      nUsable: fs.length,
      status: "insufficient",
      powerD: null,
      sigmaD: null,
      temporalSdD: null,
      intervalD: null,
      framePowers: [],
    };
    if (q.length >= cfg.minUsableFramesPerMeridian && q.length >= iv.length) {
      const p = q.map((e) => e.powerD!);
      const s2 = q.map((e) => (e.sigmaD ?? 1) ** 2);
      const tsd = robustSd(p);
      const varM = median(s2) * (1 / p.length + RHO_SYSTEMATIC) + tsd ** 2 / p.length;
      Object.assign(s, {
        status: "quantitative",
        powerD: median(p),
        sigmaD: Math.sqrt(varM),
        temporalSdD: tsd,
        framePowers: p,
      });
      obs.push({ meridianDeg: m, powerD: s.powerD!, sigmaD: s.sigmaD! });
    } else if (iv.length >= cfg.minUsableFramesPerMeridian) {
      const lo = median(iv.map((e) => e.intervalD![0]));
      const hi = median(iv.map((e) => e.intervalD![1]));
      Object.assign(s, { status: "interval", intervalD: [lo, hi] });
      intervals.push([m, lo, hi]);
    }
    res.meridians.push(s);
  }
  if (!obs.length && !intervals.length) {
    res.message = `Too few usable frames per meridian (need ${cfg.minUsableFramesPerMeridian}). Repeat the measurement.`;
    return final();
  }
  let post;
  if (obs.length) {
    post = fitPowerVector(obs);
    for (let it = 0; it < 2; it++) {
      const extra: MeridionalObservation[] = [];
      for (const [m, lo, hi] of intervals) {
        const pred = powerInMeridian(posteriorPowerVector(post), m);
        if (pred < lo || pred > hi)
          extra.push({ meridianDeg: m, powerD: pred < lo ? lo : hi, sigmaD: INTERVAL_BOUND_SD });
      }
      if (!extra.length) break;
      post = fitPowerVector([...obs, ...extra]);
    }
  } else {
    post = fitPowerVector(
      intervals.map(([m, lo, hi]) => ({
        meridianDeg: m,
        powerD: (lo + hi) / 2,
        sigmaD: (hi - lo) / Math.sqrt(12),
      })),
    );
  }
  const nQuant = countDistinctMeridians(obs.map((o) => o.meridianDeg));
  const cal = calibrated ? cfg.calibrationSdCalibrated : cfg.calibrationSdUncalibrated;
  post.cov[0][0] += acc ** 2 + cal ** 2;
  const dist = sampleRefraction(post);
  const [M, J0, J45] = post.mean;
  const sd = [0, 1, 2].map((i) => Math.sqrt(post.cov[i]![i]!));
  res.powerVector = { M, J0, J45 };
  res.powerVectorSd = { M: sd[0]!, J0: sd[1]!, J45: sd[2]! };
  res.research = {
    sph: dist.point.sph,
    cyl: dist.point.cyl,
    axis: dist.point.axis,
    sphSamples: dist.sphSamples,
    cylSamples: dist.cylSamples,
    axisSamples: dist.axisSamples,
    axisSdDeg: dist.axisSdDeg,
  };
  let readingProbs: ClassProbabilities;
  let reading: EyeReading;
  if (obs.length) {
    readingProbs = classProbabilities(M, sd[0]!, t);
    reading = { kind: "reading", meanD: M, sdD: sd[0]! };
  } else {
    const lo = Math.min(...intervals.map((i) => i[1]));
    const hi = Math.max(...intervals.map((i) => i[2]));
    readingProbs = truncatedPriorClassProbabilities(
      lo,
      hi,
      t,
      cfg.populationPriorMean,
      cfg.populationPriorSd,
    );
    res.deadZoneD = [lo, hi];
    reading = { kind: "interval", loD: lo, hiD: hi, sdD: Math.sqrt(acc ** 2 + cal ** 2) };
  }
  if (nQuant >= cfg.minDistinctMeridiansForCyl) {
    const key = String(t.astigmatismCyl);
    res.astigmatismProbability = dist.pCylGe[key] ?? dist.pCylGe["0.75"] ?? null;
  }
  if (!calibrated) res.notes.push("Device not calibrated: ±0.50 D calibration uncertainty included.");
  return {
    res,
    done: false,
    t,
    reading,
    hasObs: obs.length > 0,
    nQuant,
    nIntervals: intervals.length,
    dist,
    readingProbs,
    readingHalf: obs.length ? (dist.seCi95[1] - dist.seCi95[0]) / 2 : null,
    acc,
  };
}

const CHILD: AgeGroup[] = ["child_3_7", "child_8_12"];

/**
 * Sets what an eye's result says. With the focusing model, a number is released only when the eye's own
 * refraction is pinned to the interval limit after allowing for focusing on the light; without it (a
 * stage 1 capture, which records the eye as the camera saw it), the reading is taken as it stands.
 */
function gateEye(
  m: EyeMeasurement,
  ageGroup: AgeGroup,
  cfg: GatingConfig,
  focus: FocusPosterior | null,
  workingDistanceM: number,
): EyeResult {
  const { res, t, dist } = m;
  if (m.done || !dist) return res;
  const ef = focus?.eyes[res.eye] ?? null;
  const probs = ef ? ef.classProbabilities : m.readingProbs!;
  res.classProbabilities = probs;
  const top = topClass(probs);
  const max = cfg.maxSeCiHalfwidthQuantitative;
  const fmt = (v: number) => formatDiopters(v);
  const d = workingDistanceM.toFixed(2);
  let half = m.readingHalf;
  let shift = 0;
  if (ef && focus) {
    half = (ef.ci95[1] - ef.ci95[0]) / 2;
    res.refractionRange95 = ef.ci95;
    res.notes.push(
      `Allows for the eyes focusing on the light ${d} m away, which makes an eye read more myopic than it is: by up to ${focus.amplitudeD.toFixed(1)} D at this age, at ${Math.round(focus.focusResponse[0] * 100)}–${Math.round(focus.focusResponse[1] * 100)}% of what the eye needs.`,
      `Drift in focusing of ±${m.acc.toFixed(2)} D (SD) included for this age group.`,
    );
  } else
    res.notes.push(
      `Not corrected for focusing on the light: the reading is the eye as the camera saw it, focusing included. Drift in focusing of ±${m.acc.toFixed(2)} D (SD) included.`,
    );
  // focusing on the light can hide this much error above what the reading alone allows
  const hidden = ef ? ef.ci95[1] - (m.hasObs ? dist.seCi95[1] : res.deadZoneD![1]) : 0;
  const canHide = hidden >= 1;
  // Where focusing can hide error, a class rests on the eye's range alone: the population's prior would
  // otherwise decide how much hyperopia is hidden, so emmetropia is never claimed for such an eye.
  const cls: RefractiveClass | null = canHide
    ? ef!.ci95[1] < t.myopiaSe
      ? "myopia"
      : ef!.ci95[0] >= t.hyperopiaSe
        ? "hyperopia"
        : null
    : top.confidence >= cfg.minClassConfidenceScreening
      ? top.label
      : null;

  if (m.hasObs && half! <= max) {
    const seD = ef ? ef.medianD : res.powerVector!.M;
    shift = seD - res.powerVector!.M;
    Object.assign(res, {
      outputLevel: "quantitative",
      seD,
      seCi95: ef ? ef.ci95 : dist.seCi95,
      refractiveClass: top.label,
      severity: severityLabel(seD, t),
      confidence: top.confidence,
      message:
        Math.abs(shift) >= 0.05
          ? "Quantitative spherical-equivalent estimate within the configured uncertainty limit, allowing for the eyes focusing on the light."
          : "Quantitative spherical-equivalent estimate within the configured uncertainty limit.",
    });
  } else if (ef && m.hasObs && canHide) {
    // focusing on the light is what leaves the eye's refraction open: a repeat would read the same
    res.focusLimited = true;
    res.outputLevel = "screening";
    const [lo, hi] = ef.ci95.map(fmt);
    if (cls) Object.assign(res, { refractiveClass: cls, confidence: probs[cls] });
    if (cls === "myopia")
      res.message = `This eye is myopic, between ${lo} and ${hi}. The eyes could focus on the light ${d} m away, which makes an eye read more myopic than it is by an amount this capture cannot show, so no number is given.`;
    else if (cls === "hyperopia")
      res.message = `This eye shows hyperopia even while it can focus on the light: ${lo} or more. Finding how much needs an eye examination with eye drops.`;
    else {
      const exam = CHILD.includes(ageGroup) ? "an eye examination with eye drops" : "an eye examination";
      const open =
        ef.ci95[0] >= t.myopiaSe ? "emmetropic or hyperopic" : "emmetropic, mildly myopic or hyperopic";
      res.message = `This eye could focus on the light ${d} m away, which makes it read more myopic than it is (here ${fmt(res.powerVector!.M)}) by an amount this capture cannot show. It is no more myopic than ${lo}; whether it is ${open} needs ${exam}.`;
    }
  } else if (cls) {
    Object.assign(res, {
      outputLevel: "screening",
      refractiveClass: cls,
      confidence: probs[cls],
      seCi95: m.hasObs ? (ef ? ef.ci95 : dist.seCi95) : null,
      message: m.hasObs
        ? `Quantitative refraction unreliable (95% interval ±${half!.toFixed(2)} D). Result suggests ${cls}. Repeat measurement or obtain clinical refraction.`
        : `No photorefraction crescent detected in any meridian: the reading lies inside this setup's dead zone (${fmt(res.deadZoneD![0])} to ${fmt(res.deadZoneD![1])}). Screening result only.`,
    });
  } else if (!m.hasObs) {
    const [lo, hi] = res.deadZoneD!;
    // the eye is no more myopic than the reading, give or take its drift and calibration
    const floor = fmt(ef ? ef.ci95[0] : lo);
    const ruled = canHide
      ? `myopia beyond ${floor}, but an eye that can focus on the light can hide hyperopia here, and mild myopia cannot be told from emmetropia at this distance`
      : ef
        ? `myopia beyond ${floor} and hyperopia beyond ${fmt(ef.ci95[1])}, but mild myopia cannot be told from emmetropia at this distance`
        : `myopia beyond ${floor}, but mild myopia cannot be told from emmetropia at this distance`;
    Object.assign(res, {
      outputLevel: "screening",
      message: `No crescent detected: the reading lies between ${fmt(lo)} and ${fmt(hi)} in all measured meridians. That rules out ${ruled}. Optional: repeat at 1.5 m, or obtain clinical refraction.`,
    });
    return res;
  } else {
    res.outputLevel = "repeat";
    res.message =
      "Insufficient confidence for any refractive category. Repeat measurement in a darker room at the guided distance, or obtain clinical refraction.";
    return res;
  }
  const cylWidth = dist.cylCi95[1] - dist.cylCi95[0];
  const canCyl =
    cfg.astigmatismQuantificationEnabled &&
    res.outputLevel === "quantitative" &&
    m.nQuant >= cfg.minDistinctMeridiansForCyl &&
    cylWidth <= cfg.maxCylCiWidth &&
    (dist.point.cyl > -0.25 || dist.axisSdDeg <= cfg.maxAxisSdDeg);
  if (canCyl) {
    // focusing moves the sphere with the spherical equivalent and leaves the cylinder alone
    res.astigmatismStatus = "quantified";
    res.sphD = dist.point.sph + shift;
    res.sphCi95 = [dist.sphCi95[0] + shift, dist.sphCi95[1] + shift];
    res.cylD = dist.point.cyl;
    res.cylCi95 = dist.cylCi95;
    if (dist.point.axis !== null && dist.point.cyl <= -0.25) {
      res.axisDeg = dist.point.axis;
      res.axisUncertaintyDeg = dist.axisSdDeg * 1.96;
    }
  } else if (m.nQuant >= 2 || (m.nQuant >= 1 && m.nIntervals)) {
    res.astigmatismStatus = "screening_only";
    if (!cfg.astigmatismQuantificationEnabled)
      res.notes.push(
        "CYL/AXIS quantification is disabled until validated on controlled multi-meridian data.",
      );
  } else res.notes.push("Only one meridian measured: astigmatism not assessed (prior used).");
  return res;
}

/** The working distance the frames measured: the median of their distances, or 1 m with none. */
function workingDistance(frames: FrameRecord[]): number {
  const d = frames
    .filter((f) => isUsable(f.quality) && f.estimate && f.estimate.meridianDeg !== null)
    .map((f) => f.metadata.workingDistanceM)
    .filter((v) => Number.isFinite(v) && v > 0);
  return d.length ? median(d) : 1;
}

/** One eye on its own: its fellow is taken from the population, given this eye. */
export function fuseEye(
  eye: EyeSide,
  frames: FrameRecord[],
  ageGroup: AgeGroup,
  calibrated: boolean,
  cfg: GatingConfig = DEFAULT_GATING,
  focusModel = true,
): EyeResult {
  const m = measureEye(eye, frames, ageGroup, calibrated, cfg);
  const d = workingDistance(frames);
  const none: EyeReading = { kind: "none" };
  const focus =
    focusModel && !m.done
      ? focusPosterior(
          { OD: eye === "OD" ? m.reading : none, OS: eye === "OS" ? m.reading : none },
          ageGroup,
          d,
          m.t,
          focusConfig(cfg),
        )
      : null;
  return gateEye(m, ageGroup, cfg, focus, d);
}

export interface ReportInput {
  frames: FrameRecord[];
  ageGroup: AgeGroup;
  deviceId: string;
  calibrationVersion: string;
  estimator: { name: string; version: string; kind: string };
  extractorVersion: string;
  gating?: GatingConfig;
  symptomsReported?: boolean;
  id?: string;
  /**
   * Allow for the eyes focusing on the light. A stage 1 capture turns it off: through a trial lens the
   * point is the eye as the camera saw it. It defaults to on, except for a learned estimator: that predicts
   * each meridian's own refraction, having learned from clinical refractions how its training eyes focused.
   */
  focusModel?: boolean;
}

export function buildReport(input: ReportInput): AssessmentReport {
  const { frames, ageGroup } = input;
  const cfg = input.gating ?? DEFAULT_GATING;
  const simulated = frames.some((f) => f.metadata.simulated);
  if (simulated && !frames.every((f) => f.metadata.simulated))
    throw new Error("Mixing simulated and real frames in one report is not allowed.");
  const calibrated = input.calibrationVersion !== "uncalibrated";
  const mOD = measureEye(
    "OD",
    frames.filter((f) => f.metadata.eye === "OD"),
    ageGroup,
    calibrated,
    cfg,
  );
  const mOS = measureEye(
    "OS",
    frames.filter((f) => f.metadata.eye === "OS"),
    ageGroup,
    calibrated,
    cfg,
  );
  const d = workingDistance(frames);
  // the eyes focus together, so the model reads both eyes at once
  const focus =
    (input.focusModel ?? input.estimator.kind !== "ml")
      ? focusPosterior({ OD: mOD.reading, OS: mOS.reading }, ageGroup, d, mOD.t, focusConfig(cfg))
      : null;
  const od = gateEye(mOD, ageGroup, cfg, focus, d);
  const os = gateEye(mOS, ageGroup, cfg, focus, d);
  const t = thresholdsForAge(ageGroup);
  const provenance: Provenance = {
    modelName: input.estimator.name,
    modelVersion: input.estimator.version,
    estimatorKind: input.estimator.kind,
    calibrationVersion: input.calibrationVersion,
    deviceProfile: input.deviceId,
    extractorVersion: input.extractorVersion,
    appVersion: APP_VERSION,
    timestamp: new Date().toISOString(),
  };
  const rep: AssessmentReport = {
    id:
      input.id ??
      (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r-${Date.now()}`),
    simulated,
    eyes: { OD: od, OS: os },
    anisometropiaProbability: null,
    seDifferenceD: null,
    reflexAsymmetryRatio: null,
    reflexAsymmetryFlag: false,
    referralReasons: [],
    interpretation: "",
    disclaimer: MEDICAL_DISCLAIMER,
    provenance,
    focus: focus ? focusSummary(focus, d) : null,
  };
  const reasons: string[] = [];
  if (od.powerVector && os.powerVector && od.outputLevel !== "repeat" && os.outputLevel !== "repeat") {
    const acc = ACCOMMODATION_SD[ageGroup] ?? 0.5;
    const sa = Math.sqrt(Math.max(od.powerVectorSd!.M ** 2 - acc ** 2 / 2, 0.01));
    const sb = Math.sqrt(Math.max(os.powerVectorSd!.M ** 2 - acc ** 2 / 2, 0.01));
    rep.seDifferenceD = od.powerVector.M - os.powerVector.M;
    rep.anisometropiaProbability = anisometropiaProbability(
      od.powerVector.M,
      sa,
      os.powerVector.M,
      sb,
      t.anisometropiaSe,
    );
    if (rep.anisometropiaProbability >= 0.5)
      reasons.push("Significant difference between eyes (possible anisometropia).");
  }
  if (od.reflexMeanLuma && os.reflexMeanLuma) {
    const ratio =
      Math.max(od.reflexMeanLuma, os.reflexMeanLuma) /
      Math.max(Math.min(od.reflexMeanLuma, os.reflexMeanLuma), 1e-6);
    rep.reflexAsymmetryRatio = ratio;
    if (ratio >= cfg.reflexAsymmetryRatio) {
      rep.reflexAsymmetryFlag = true;
      reasons.push(
        "Red-reflex brightness differs between eyes. This can have causes other than refractive error and needs a professional eye examination.",
      );
    }
  }
  for (const r of [od, os]) {
    if (r.outputLevel === "repeat")
      reasons.push(`${r.eye}: measurement unreliable - repeat or obtain clinical refraction.`);
    else if (r.confidence !== null && r.confidence < 0.9) reasons.push(`${r.eye}: confidence below 90%.`);
    if (r.powerVector && (r.powerVector.M <= t.highMyopiaSe || r.powerVector.M >= t.highHyperopiaSe))
      reasons.push(`${r.eye}: possible high refractive error.`);
    if (r.astigmatismProbability !== null && r.astigmatismProbability >= 0.7)
      reasons.push(`${r.eye}: astigmatism likely.`);
  }
  if (input.symptomsReported) reasons.push("Visual symptoms reported.");
  rep.referralReasons = reasons;
  const labels = [od, os].map((r) => r.refractiveClass).filter((l): l is NonNullable<typeof l> => l !== null);
  // an eye with a range but no class: no crescent, or a reading that focusing on the light leaves open
  const ranged = [od, os].filter((r) => r.outputLevel === "screening" && r.refractiveClass === null);
  if (!labels.length && ranged.length)
    rep.interpretation =
      "No refractive error this method can measure at this distance." +
      (focus && (focus.pFocusing >= 0.05 || ranged.some((r) => r.focusLimited))
        ? " An eye that can focus on the light hides hyperopia and mild myopia from it."
        : "") +
      (ranged.length < 2 ? " Repeat the measurement for the other eye." : "");
  else if (!labels.length)
    rep.interpretation = "No reliable refractive pattern could be determined. Please repeat the measurement.";
  else if (labels.every((l) => l === "emmetropia"))
    rep.interpretation =
      "Measurements do not show a significant spherical refractive error within this method's limits.";
  else {
    const kinds = [...new Set(labels.filter((l) => l !== "emmetropia"))].sort();
    rep.interpretation = `Your measurements show a pattern consistent with ${kinds.join(" and ")} refractive error.`;
  }
  // an eye whose range, focusing allowed for, reaches hyperopia has not had it ruled out
  if (
    focus &&
    CHILD.includes(ageGroup) &&
    [od, os].some(
      (r) => r.outputLevel !== "repeat" && (r.refractionRange95?.[1] ?? -Infinity) >= t.hyperopiaSe,
    )
  )
    rep.interpretation +=
      " In children, hyperopia is usually only found with eye drops (a cycloplegic refraction); this capture does not rule it out.";
  if (simulated) rep.interpretation = `SIMULATED DATA. ${rep.interpretation}`;
  return rep;
}

function focusSummary(f: FocusPosterior, workingDistanceM: number): FocusSummary {
  return {
    workingDistanceM,
    lightD: f.lightD,
    amplitudeD: f.amplitudeD,
    focusResponse: f.focusResponse,
    pFocusing: f.pFocusing,
    meanFocusD: f.meanFocusD,
  };
}
