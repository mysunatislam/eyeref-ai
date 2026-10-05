/**
 * The validation study report that `make study` writes (ml/eyeref_ml/evaluation/study.py), as JSON.
 * Snake_case as written. shared/fixtures/study_report.sample.json is a made-up, simulated example.
 */

/** A statistic with its 95% bootstrap interval. Either is null when it could not be computed. */
export interface Estimate {
  value: number | null;
  ci95: [number, number] | null;
}
type Estimates = Record<string, Estimate>;

export const OUTCOMES = ["quantitative", "screening", "repeat", "protocol_failure"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The 2x2 table of referral against the reference, and how many referrals were unscreened eyes. */
export interface CrossTable {
  true_positive: number;
  false_positive: number;
  false_negative: number;
  true_negative: number;
  not_screened: number;
}
export interface RocPoint {
  refer_from: number;
  sensitivity: number;
  specificity: number;
}
export interface CalibrationBin {
  from: number;
  to: number;
  eyes: number;
  predicted: number;
  observed: number;
}

export interface StudyReport {
  kind: "eyeref-study-report";
  format_version: 1;
  /** Present when the data were simulated: "SIMULATED DATA: not evidence about real eyes". */
  label?: string;
  generated_at: string;
  eyeref_ml_version: string;
  simulated: boolean;
  reference: string;
  model_versions: string[];
  eyes_per_subject: string;
  eyes_left_out_other_model_versions: number;
  n: Record<Outcome, number> & {
    subjects: number;
    visits: number;
    eyes: number;
    eyes_with_reference: number;
    eyes_compared: number;
    eyes_compared_at_cornea: number;
    repeatability_eyes: number;
    repeatability_measurements: number;
    screening_tables: Record<string, CrossTable>;
    subgroups: Record<string, Record<string, number>>;
  };
  bootstrap: { replicates: number; seed: number; resampled: string; interval: string };
  metrics: {
    outcomes: Record<Outcome, Estimate>;
    agreement?: Record<string, Estimates>;
    screening?: Record<string, Estimates>;
    calibration?: Record<string, { ece: Estimate }>;
    repeatability?: Estimates;
    subgroups?: Record<string, Record<string, Estimates>>;
  };
  roc_curves: Record<string, RocPoint[]>;
  calibration_tables: Record<string, CalibrationBin[]>;
  /** Each eye given a number: the mean of the released and reference SE, and their difference. */
  bland_altman_se: { mean: number; diff: number }[];
}

export class StudyReportError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a study report, or says in plain words why the file is not one this page can show. */
export function parseStudyReport(text: string): StudyReport {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new StudyReportError("This file is not JSON. Choose the study.json that `make study` writes.");
  }
  if (!isObject(j) || j.kind !== "eyeref-study-report")
    throw new StudyReportError(
      "This is not an EyeRef study report. Choose the study.json that `make study` writes.",
    );
  if (j.format_version !== 1)
    throw new StudyReportError(
      `This report is in format ${String(j.format_version)}, which this version of the app cannot read.`,
    );
  const missing = ["n", "bootstrap", "metrics", "roc_curves", "calibration_tables"].filter(
    (k) => !isObject(j[k]),
  );
  if (!Array.isArray(j.bland_altman_se)) missing.push("bland_altman_se");
  if (typeof j.simulated !== "boolean") missing.push("simulated");
  if (isObject(j.metrics) && !isObject(j.metrics.outcomes)) missing.push("metrics.outcomes");
  if (missing.length) throw new StudyReportError(`This study report is incomplete: ${missing.join(", ")}.`);
  return j as unknown as StudyReport;
}

/** The screening questions, in the protocol's order, as the report names them. */
export const SCREENING_LABEL: Record<string, string> = {
  myopia_0_50: "Myopia, SE −0.50 D or less",
  myopia_1_00: "Myopia, SE −1.00 D or less",
  hyperopia: "Hyperopia",
  astigmatism: "Astigmatism",
  anisometropia: "Anisometropia, 1.00 D or more",
};

export const SUBGROUP_LABEL: Record<string, string> = {
  device_id: "Device",
  age_group: "Age group",
  refractive_range: "Refractive range (D)",
  pupil_band: "Pupil size",
  distance_band: "Distance",
  iris_color: "Iris colour",
  pigmentation: "Pigmentation",
  sex: "Sex",
};

/** ROC points for a chart, from "refer nobody" at (0, 0) to the lowest score's referral. */
export const rocPoints = (curve: RocPoint[]) => [
  { fpr: 0, tpr: 0 },
  ...curve.map((p) => ({ fpr: 1 - p.specificity, tpr: p.sensitivity })),
];
