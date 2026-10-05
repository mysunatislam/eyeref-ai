/** Investigator-side helpers: pairing predictions with ground truth, local agreement stats, CSV export. */
import { sphericalEquivalent, transpose } from "./optics/powerVector";
import type { EyeSide, GroundTruthEntry, StoredAssessment } from "./types";

export const METHOD_PRIORITY: GroundTruthEntry["method"][] = [
  "cycloplegic",
  "subjective",
  "autorefractor",
  "retinoscopy",
  "trial_lens",
];

/** Ground truth in minus-cylinder form (instrument printouts may be plus-cyl). */
export function normalizeGt(g: GroundTruthEntry): GroundTruthEntry {
  if (g.cylinder <= 0) return g;
  const t = transpose({ sph: g.sphere, cyl: g.cylinder, axis: g.axis });
  return { ...g, sphere: t.sph, cylinder: t.cyl, axis: t.axis };
}

/** The record's reference for one eye: the best method taken, and of that method the latest entry, as on the server. */
export function bestGt(a: StoredAssessment, eye: EyeSide): GroundTruthEntry | null {
  const gts = (a.groundTruth ?? []).filter((g) => g.eye === eye);
  for (const m of METHOD_PRIORITY) {
    const g = gts.findLast((x) => x.method === m);
    if (g) return normalizeGt(g);
  }
  return null;
}

export interface PairRow {
  id: string;
  code: string;
  eye: EyeSide;
  simulated: boolean;
  ageGroup: string;
  device: string;
  outputLevel: string;
  predSe: number | null;
  predCiLow: number | null;
  predCiHigh: number | null;
  predClass: string | null;
  confidence: number | null;
  posteriorM: number | null;
  gtMethod: string | null;
  gtSph: number | null;
  gtCyl: number | null;
  gtAxis: number | null;
  gtSe: number | null;
  usableFrames: number;
  frames: number;
  modelVersion: string;
}

export function pairRows(items: StoredAssessment[]): PairRow[] {
  return items.flatMap((a) =>
    (["OD", "OS"] as const).map((eye) => {
      const r = a.report.eyes[eye];
      const g = bestGt(a, eye);
      return {
        id: a.id,
        code: a.profile.datasetCode ?? a.profile.label,
        eye,
        simulated: a.report.simulated,
        ageGroup: a.profile.ageGroup,
        device: a.report.provenance.deviceProfile,
        outputLevel: r.outputLevel,
        predSe: r.outputLevel === "quantitative" ? r.seD : null,
        predCiLow: r.seCi95?.[0] ?? null,
        predCiHigh: r.seCi95?.[1] ?? null,
        predClass: r.refractiveClass,
        confidence: r.confidence,
        posteriorM: r.powerVector?.M ?? null,
        gtMethod: g?.method ?? null,
        gtSph: g?.sphere ?? null,
        gtCyl: g?.cylinder ?? null,
        gtAxis: g?.axis ?? null,
        gtSe: g ? sphericalEquivalent({ sph: g.sphere, cyl: g.cylinder, axis: g.axis }) : null,
        usableFrames: r.nUsableFrames,
        frames: r.nFrames,
        modelVersion: `${a.report.provenance.modelName}@${a.report.provenance.modelVersion}`,
      };
    }),
  );
}

export function agreement(rows: PairRow[], key: "predSe" | "posteriorM") {
  const p = rows.filter((r) => r[key] !== null && r.gtSe !== null).map((r) => r[key]! - r.gtSe!);
  if (!p.length) return null;
  const mean = p.reduce((s, v) => s + v, 0) / p.length;
  const sd = Math.sqrt(p.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(p.length - 1, 1));
  const abs = p.map(Math.abs);
  return {
    n: p.length,
    mae: abs.reduce((s, v) => s + v, 0) / p.length,
    bias: mean,
    loa: [mean - 1.96 * sd, mean + 1.96 * sd] as [number, number],
    within050: abs.filter((v) => v <= 0.5).length / p.length,
  };
}

export function toCsv(rows: PairRow[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!) as (keyof PairRow)[];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
