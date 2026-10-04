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
} from "../optics/classification";
import {
  countDistinctMeridians,
  fitPowerVector,
  posteriorPowerVector,
  sampleRefraction,
  type MeridionalObservation,
} from "../optics/meridional";
import { normalizeAxis, powerInMeridian } from "../optics/powerVector";
import { isUsable } from "../cv/quality";
import type {
  AgeGroup,
  AssessmentReport,
  EyeResult,
  EyeSide,
  FrameRecord,
  MeridianSummary,
  Provenance,
  QualityGrade,
} from "../types";

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
};

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

export function fuseEye(
  eye: EyeSide,
  frames: FrameRecord[],
  ageGroup: AgeGroup,
  calibrated: boolean,
  cfg: GatingConfig = DEFAULT_GATING,
): EyeResult {
  const t = thresholdsForAge(ageGroup);
  const usable = frames.filter((f) => isUsable(f.quality) && f.estimate && f.estimate.meridianDeg !== null);
  const res = emptyEye(eye, frames, usable);
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
    return res;
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
    return res;
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
  const acc = ACCOMMODATION_SD[ageGroup] ?? 0.5;
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
  let probs: ClassProbabilities;
  if (obs.length) probs = classProbabilities(M, sd[0]!, t);
  else {
    const lo = Math.min(...intervals.map((i) => i[1]));
    const hi = Math.max(...intervals.map((i) => i[2]));
    probs = truncatedPriorClassProbabilities(lo, hi, t, cfg.populationPriorMean, cfg.populationPriorSd);
    res.deadZoneD = [lo, hi];
  }
  res.classProbabilities = probs;
  if (nQuant >= cfg.minDistinctMeridiansForCyl) {
    const key = String(t.astigmatismCyl);
    res.astigmatismProbability = dist.pCylGe[key] ?? dist.pCylGe["0.75"] ?? null;
  }
  res.notes.push(
    `Non-cycloplegic measurement: accommodation uncertainty of ±${acc.toFixed(2)} D (SD) included for this age group. True refraction may be more hyperopic than measured.`,
  );
  if (!calibrated) res.notes.push("Device not calibrated: ±0.50 D calibration uncertainty included.");

  const seHalf = (dist.seCi95[1] - dist.seCi95[0]) / 2;
  const top = topClass(probs);
  if (obs.length && seHalf <= cfg.maxSeCiHalfwidthQuantitative) {
    Object.assign(res, {
      outputLevel: "quantitative",
      seD: M,
      seCi95: dist.seCi95,
      refractiveClass: top.label,
      severity: severityLabel(M, t),
      confidence: top.confidence,
      message: "Quantitative spherical-equivalent estimate within the configured uncertainty limit.",
    });
  } else if (top.confidence >= cfg.minClassConfidenceScreening) {
    Object.assign(res, {
      outputLevel: "screening",
      refractiveClass: top.label,
      confidence: top.confidence,
      seCi95: obs.length ? dist.seCi95 : null,
      message: obs.length
        ? `Quantitative refraction unreliable (95% interval ±${seHalf.toFixed(2)} D). Result suggests ${top.label}. Repeat measurement or obtain clinical refraction.`
        : `No photorefraction crescent detected in any meridian: refraction lies inside this setup's dead zone (${res.deadZoneD![0].toFixed(2)} to ${res.deadZoneD![1].toFixed(2)} D). Screening result only.`,
    });
  } else if (!obs.length) {
    Object.assign(res, {
      outputLevel: "screening",
      message: `No crescent detected: refraction lies between ${res.deadZoneD![0].toFixed(2)} and ${res.deadZoneD![1].toFixed(2)} D in all measured meridians. This excludes larger refractive errors but cannot separate mild myopia from emmetropia at this distance. Optional: repeat at 1.5 m, or obtain clinical refraction.`,
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
    nQuant >= cfg.minDistinctMeridiansForCyl &&
    cylWidth <= cfg.maxCylCiWidth &&
    (dist.point.cyl > -0.25 || dist.axisSdDeg <= cfg.maxAxisSdDeg);
  if (canCyl) {
    res.astigmatismStatus = "quantified";
    res.sphD = dist.point.sph;
    res.sphCi95 = dist.sphCi95;
    res.cylD = dist.point.cyl;
    res.cylCi95 = dist.cylCi95;
    if (dist.point.axis !== null && dist.point.cyl <= -0.25) {
      res.axisDeg = dist.point.axis;
      res.axisUncertaintyDeg = dist.axisSdDeg * 1.96;
    }
  } else if (nQuant >= 2 || (nQuant >= 1 && intervals.length)) {
    res.astigmatismStatus = "screening_only";
    if (!cfg.astigmatismQuantificationEnabled)
      res.notes.push(
        "CYL/AXIS quantification is disabled until validated on controlled multi-meridian data.",
      );
  } else res.notes.push("Only one meridian measured: astigmatism not assessed (prior used).");
  return res;
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
}

export function buildReport(input: ReportInput): AssessmentReport {
  const { frames, ageGroup } = input;
  const cfg = input.gating ?? DEFAULT_GATING;
  const simulated = frames.some((f) => f.metadata.simulated);
  if (simulated && !frames.every((f) => f.metadata.simulated))
    throw new Error("Mixing simulated and real frames in one report is not allowed.");
  const calibrated = input.calibrationVersion !== "uncalibrated";
  const od = fuseEye(
    "OD",
    frames.filter((f) => f.metadata.eye === "OD"),
    ageGroup,
    calibrated,
    cfg,
  );
  const os = fuseEye(
    "OS",
    frames.filter((f) => f.metadata.eye === "OS"),
    ageGroup,
    calibrated,
    cfg,
  );
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
  if (!labels.length)
    rep.interpretation = "No reliable refractive pattern could be determined. Please repeat the measurement.";
  else if (labels.every((l) => l === "emmetropia"))
    rep.interpretation =
      "Measurements do not show a significant spherical refractive error within this method's limits.";
  else {
    const kinds = [...new Set(labels.filter((l) => l !== "emmetropia"))].sort();
    rep.interpretation = `Your measurements show a pattern consistent with ${kinds.join(" and ")} refractive error.`;
  }
  if (simulated) rep.interpretation = `SIMULATED DATA. ${rep.interpretation}`;
  return rep;
}
