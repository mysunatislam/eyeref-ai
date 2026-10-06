/**
 * The study report page reads what ml/eyeref_ml/evaluation/study.py writes. The sample in
 * shared/fixtures is written by ml/tests/test_study.py from a made-up, simulated study, and that test
 * fails if the analysis's output drifts from it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRAME_FAILURE_LABEL,
  GRADES,
  parseStudyReport,
  rocPoints,
  SCREENING_LABEL,
  StudyReportError,
} from "../studyReport";

const SAMPLE = readFileSync(
  resolve(__dirname, "../../../../../shared/fixtures/study_report.sample.json"),
  "utf8",
);

describe("study report", () => {
  it("reads what the analysis writes, and keeps its simulated label", () => {
    const r = parseStudyReport(SAMPLE);
    expect(r.simulated).toBe(true);
    expect(r.label).toMatch(/^SIMULATED DATA/);
    expect(Object.keys(r.metrics.screening ?? {}).sort()).toEqual(Object.keys(SCREENING_LABEL).sort());
    const t = r.n.screening_tables.myopia_0_50!;
    const eyes = t.true_positive + t.false_positive + t.false_negative + t.true_negative;
    expect(eyes).toBe(r.n.eyes_with_reference);
    expect(r.bland_altman_se).toHaveLength(r.n.eyes_compared);
  });

  it("draws each ROC curve from referring nobody to referring everyone", () => {
    const r = parseStudyReport(SAMPLE);
    for (const curve of Object.values(r.roc_curves)) {
      const pts = rocPoints(curve);
      expect(pts[0]).toEqual({ fpr: 0, tpr: 0 });
      expect(pts.at(-1)).toEqual({ fpr: 1, tpr: 1 }); // every eye scores at least the lowest score
      for (let i = 1; i < pts.length; i++) {
        expect(pts[i]!.fpr).toBeGreaterThanOrEqual(pts[i - 1]!.fpr);
        expect(pts[i]!.tpr).toBeGreaterThanOrEqual(pts[i - 1]!.tpr);
      }
    }
  });

  it("judges the gate over every eye with a reference, and counts every graded frame", () => {
    const r = parseStudyReport(SAMPLE);
    const n = r.n.gate!;
    expect(n.released + n.held_back + n.no_number).toBe(r.n.eyes_with_reference);
    const g = r.metrics.gate!;
    expect(g.released!.share!.value! + g.held_back!.share!.value!).toBeCloseTo(g.no_gate!.share!.value!, 5);
    // the curve ends with every eye that had a number released, at the no-gate error
    const curve = r.risk_coverage!;
    expect(curve.at(-1)!.coverage).toBeCloseTo(g.no_gate!.share!.value!, 3);
    expect(curve.at(-1)!.mae).toBeCloseTo(g.no_gate!.mae!.value!, 3);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!.coverage).toBeGreaterThan(curve[i - 1]!.coverage);

    const f = r.metrics.frames!;
    expect(GRADES.reduce((a, k) => a + f.graded[k].value!, 0)).toBeCloseTo(1, 5);
    for (const reason of Object.keys(f.failed ?? {})) expect(FRAME_FAILURE_LABEL[reason]).toBeTruthy();
  });

  it("still opens a report written before the gate analysis", () => {
    const { risk_coverage: _, ...older } = JSON.parse(SAMPLE) as Record<string, unknown>;
    const r = parseStudyReport(JSON.stringify(older));
    expect(r.risk_coverage).toBeUndefined();
  });

  it("says in plain words why a file is not a report it can show", () => {
    const sample = JSON.parse(SAMPLE) as Record<string, unknown>;
    const reason = (text: string) => {
      try {
        parseStudyReport(text);
        return null;
      } catch (e) {
        expect(e).toBeInstanceOf(StudyReportError);
        return (e as Error).message;
      }
    };
    expect(reason("eye,se\nOD,-1")).toMatch(/not JSON/);
    expect(reason(JSON.stringify({ generated_at: "2026-01-01", experiments: {} }))).toMatch(
      /not an EyeRef study report/,
    );
    expect(reason(JSON.stringify({ ...sample, format_version: 2 }))).toMatch(/format 2/);
    const { roc_curves: _, bland_altman_se: __, ...partial } = sample;
    expect(reason(JSON.stringify(partial))).toBe(
      "This study report is incomplete: roc_curves, bland_altman_se.",
    );
  });
});
