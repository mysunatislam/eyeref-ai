"use client";
import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Stat } from "@/components/ui/stat";
import {
  OUTCOMES,
  rocPoints,
  SCREENING_LABEL,
  SUBGROUP_LABEL,
  type CrossTable,
  type Estimate,
  type StudyReport,
} from "@/lib/studyReport";
import { AGE_LABEL, cn, formatDateTime, pct, plural, UI_LOCALE } from "@/lib/utils";
import { BlandAltman, ReliabilityChart, RocChart } from "./Charts";

const OUTCOME_LABEL: Record<string, string> = {
  quantitative: "Given a number",
  screening: "Screening result",
  repeat: "Asked to repeat",
  protocol_failure: "Protocol failure",
};

/** Dioptres to two decimals; never "-0.00". */
function dioptres(v: number, signed = false) {
  const r = Math.round(v * 100) / 100 + 0;
  return `${signed && r >= 0 ? "+" : ""}${r.toFixed(2)} D`;
}
const num = (digits: number) => (v: number) =>
  (Math.round(v * 10 ** digits) / 10 ** digits + 0).toFixed(digits);
const percent = (v: number) => pct(v);

/** A statistic and its 95% interval, as "−0.12 D" and "−0.30 to +0.05 D". */
function shown(e: Estimate | undefined, f: (v: number) => string) {
  if (!e || e.value === null) return { value: "—", ci: null };
  return { value: f(e.value), ci: e.ci95 ? `${f(e.ci95[0])} to ${f(e.ci95[1])}` : null };
}

function EstimateStat({ label, e, f }: { label: string; e: Estimate | undefined; f: (v: number) => string }) {
  const s = shown(e, f);
  return <Stat label={label} value={s.value} sub={s.ci && `95% CI ${s.ci}`} />;
}

function EstimateCell({ e, f }: { e: Estimate | undefined; f: (v: number) => string }) {
  const s = shown(e, f);
  return (
    <td className="py-1.5 pr-3 align-top">
      {s.value}
      {s.ci && <div className="text-muted text-[10px]">{s.ci}</div>}
    </td>
  );
}

const groupLabel = (col: string, value: string) =>
  col === "age_group" ? (AGE_LABEL[value] ?? value) : value;

/** "the autorefractor reference, one eye per subject, chosen at random (seed 0)" */
function design(r: StudyReport) {
  const reference =
    r.reference === "best"
      ? "the best reference measured for each eye"
      : `the ${r.reference.replace("_", " ")} reference`;
  const eyes = r.eyes_per_subject.startsWith("one")
    ? `one eye per subject${r.eyes_per_subject.slice(3)}`
    : "both eyes of each subject";
  return `${reference}, ${eyes}`;
}

export function StudyReportView({ r }: { r: StudyReport }) {
  const m = r.metrics;
  const questions = Object.keys(SCREENING_LABEL).filter((q) => m.screening?.[q]);
  const probabilities = Object.keys(r.calibration_tables).filter((k) => r.calibration_tables[k]!.length);
  const subgroups = Object.keys(m.subgroups ?? {});
  const [question, setQuestion] = useState(questions[0] ?? "");
  const [prob, setProb] = useState(probabilities[0] ?? "");
  const [sub, setSub] = useState(subgroups[0] ?? "");
  const se = m.agreement?.se;
  const n = r.n;
  const ece = shown(m.calibration?.[prob]?.ece, num(2));

  return (
    <>
      {r.label ? (
        <div className="sim-stripes border-sim/40 mb-5 flex items-start gap-3 rounded-2xl border p-4 text-sm">
          <FlaskConical className="text-sim mt-0.5 size-5 shrink-0" />
          <div>
            <div className="text-sim font-bold tracking-wider">SIMULATED STUDY DATA</div>
            <p className="text-ink-2 mt-1">
              This report was computed from simulated data, so it is not evidence about real eyes.
            </p>
          </div>
        </div>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Who was measured
              {!r.label && <Badge tone="accent">Study data</Badge>}
            </CardTitle>
            <CardDescription>
              Model {r.model_versions.join(", ") || "none"} against {design(r)}.{" "}
              {plural(n.subjects, "subject")}, {plural(n.visits, "visit")}, {plural(n.eyes, "eye")}.
              {r.eyes_left_out_other_model_versions > 0 &&
                ` ${plural(r.eyes_left_out_other_model_versions, "eye")} with results only from other model versions left out.`}{" "}
              {r.bootstrap.replicates > 0
                ? `Intervals are 95% percentile intervals from ${r.bootstrap.replicates.toLocaleString(UI_LOCALE)} resamples of subjects.`
                : "No intervals: the analysis ran without resampling."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {OUTCOMES.map((o) => {
            const s = shown(m.outcomes[o], percent);
            return (
              <Stat
                key={o}
                label={OUTCOME_LABEL[o]!}
                value={n[o]}
                sub={`${s.value} of eyes${s.ci ? ` (${s.ci})` : ""}`}
                tone={o === "protocol_failure" && n[o] > 0 ? "warn" : undefined}
              />
            );
          })}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Agreement for eyes given a number</CardTitle>
              <CardDescription>
                Released SE minus the reference, over {plural(n.eyes_compared, "eye")}
                {n.eyes_compared_at_cornea > 0 &&
                  `, ${n.eyes_compared_at_cornea} of them compared at the cornea (reference beyond ±4 D)`}
                .
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <EstimateStat label="Bias" e={se?.bias} f={(v) => dioptres(v, true)} />
            <EstimateStat label="Mean absolute error" e={se?.mae} f={(v) => dioptres(v)} />
            <EstimateStat label="Lower limit of agreement" e={se?.loa_low} f={(v) => dioptres(v, true)} />
            <EstimateStat label="Upper limit of agreement" e={se?.loa_high} f={(v) => dioptres(v, true)} />
            <EstimateStat label="Within ±0.50 D" e={se?.within_0_50} f={percent} />
            <EstimateStat
              label="Reference inside the 95% interval"
              e={m.agreement?.se_ci95?.coverage}
              f={percent}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Bland–Altman (SE)</CardTitle>
              <CardDescription>
                Each point is an eye given a number. Lines: bias and 95% limits.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {se?.bias?.value != null && se.loa_low?.value != null && se.loa_high?.value != null ? (
              <BlandAltman
                ba={{
                  mean_diff: se.bias.value,
                  loa_low: se.loa_low.value,
                  loa_high: se.loa_high.value,
                  points: r.bland_altman_se,
                }}
              />
            ) : (
              <p className="text-muted text-xs">Fewer than three eyes were given a number.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <div>
            <CardTitle>Screening accuracy</CardTitle>
            <CardDescription>
              Every eye with a reference counts. An eye that could not be screened, or was given no
              probability, counts as referred. Referral is at a probability of 0.5, and 0.7 for astigmatism.
              Choose a row to see its ROC curve.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Screening accuracy table"
        >
          {questions.length ? (
            <table className="num w-full min-w-[820px] text-xs">
              <thead className="text-muted text-left text-[10px] tracking-wider uppercase">
                <tr>
                  {[
                    "Condition",
                    "With it",
                    "Sensitivity",
                    "Specificity",
                    "PPV",
                    "NPV",
                    "AUC",
                    "Unscreened",
                  ].map((h) => (
                    <th key={h} className="py-1.5 pr-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => {
                  const s = m.screening![q]!;
                  const t: CrossTable | undefined = n.screening_tables[q];
                  const cases = t ? t.true_positive + t.false_negative : null;
                  const total = t ? cases! + t.false_positive + t.true_negative : null;
                  return (
                    <tr
                      key={q}
                      onClick={() => setQuestion(q)}
                      className={cn(
                        "border-line hover:bg-surface-2 cursor-pointer border-t",
                        q === question && "bg-accent-soft",
                      )}
                    >
                      <td className="py-1.5 pr-3 align-top font-medium">
                        <button
                          type="button"
                          className="text-left"
                          aria-pressed={q === question}
                          onClick={() => setQuestion(q)}
                        >
                          {SCREENING_LABEL[q]}
                        </button>
                      </td>
                      <td className="py-1.5 pr-3 align-top">
                        {t ? `${cases} of ${plural(total!, q === "anisometropia" ? "visit" : "eye")}` : "—"}
                      </td>
                      <EstimateCell e={s.sensitivity} f={percent} />
                      <EstimateCell e={s.specificity} f={percent} />
                      <EstimateCell e={s.ppv} f={percent} />
                      <EstimateCell e={s.npv} f={percent} />
                      <EstimateCell e={s.auc} f={num(2)} />
                      <td className="py-1.5 align-top">{t ? t.not_screened : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-muted text-xs">No eye had a reference to screen against.</p>
          )}
        </CardContent>
      </Card>

      {question && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>ROC: {SCREENING_LABEL[question]}</CardTitle>
                <CardDescription>
                  AUC {shown(m.screening?.[question]?.auc, num(2)).value}. Sensitivity against 1 −
                  specificity, referring from each probability an eye was given.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {r.roc_curves[question]?.length ? (
                <RocChart roc={rocPoints(r.roc_curves[question]!)} />
              ) : (
                <p className="text-muted text-xs">
                  No curve: every eye was on the same side of the reference.
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Referral against the reference</CardTitle>
                <CardDescription>
                  {SCREENING_LABEL[question]}: referred or passed, against what the reference found. STARD
                  2015 asks for this table.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {n.screening_tables[question] ? (
                <CrossTableView
                  t={n.screening_tables[question]!}
                  unit={question === "anisometropia" ? "visit" : "eye"}
                />
              ) : (
                <p className="text-muted text-xs">No table for this condition.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Calibration</CardTitle>
              <CardDescription>
                Each point is a tenth of predicted probability, sized by its eyes. A calibrated probability
                sits on the diagonal.
              </CardDescription>
            </div>
            {probabilities.length > 0 && (
              <Select
                aria-label="Probability to show calibration for"
                className="max-w-[160px]"
                value={prob}
                onChange={(ev) => setProb(ev.target.value)}
              >
                {probabilities.map((k) => (
                  <option key={k} value={k}>
                    {k[0]!.toUpperCase() + k.slice(1)}
                  </option>
                ))}
              </Select>
            )}
          </CardHeader>
          <CardContent>
            {prob ? (
              <>
                <ReliabilityChart bins={r.calibration_tables[prob]!} />
                <p className="text-muted mt-2 text-xs">
                  Expected calibration error {ece.value}
                  {ece.ci && ` (95% CI ${ece.ci})`}: the mean gap between predicted and observed frequency,
                  weighted by eyes.
                </p>
              </>
            ) : (
              <p className="text-muted text-xs">No screened eye with a reference was given a probability.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Repeatability</CardTitle>
              <CardDescription>
                The released SE of the same eye from separate visits on the same day.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {m.repeatability ? (
              <div className="grid grid-cols-2 gap-4">
                <EstimateStat label="ICC" e={m.repeatability.icc} f={num(2)} />
                <EstimateStat label="Within-subject SD" e={m.repeatability.sw} f={(v) => dioptres(v)} />
                <EstimateStat
                  label="Coefficient of repeatability"
                  e={m.repeatability.cor}
                  f={(v) => dioptres(v)}
                />
                <Stat
                  label="Measured"
                  value={plural(n.repeatability_eyes, "eye")}
                  sub={`${n.repeatability_measurements} measurements`}
                />
              </div>
            ) : (
              <p className="text-muted text-xs">
                No eye was measured more than once on the same day. The research protocol repeats the whole
                capture for this.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {sub && (
        <Card className="mt-4">
          <CardHeader>
            <div>
              <CardTitle>Subgroups</CardTitle>
              <CardDescription>
                How often eyes were given a number, and SE agreement, in each group. Pupil size and distance
                are the medians over that eye&apos;s captures.
              </CardDescription>
            </div>
            <Select
              aria-label="Subgroup"
              className="max-w-[200px]"
              value={sub}
              onChange={(ev) => setSub(ev.target.value)}
            >
              {subgroups.map((k) => (
                <option key={k} value={k}>
                  {SUBGROUP_LABEL[k] ?? k}
                </option>
              ))}
            </Select>
          </CardHeader>
          <CardContent className="overflow-x-auto" tabIndex={0} role="region" aria-label="Subgroup table">
            <table className="num w-full min-w-[640px] text-xs">
              <thead className="text-muted text-left text-[10px] tracking-wider uppercase">
                <tr>
                  {["Group", "Eyes", "Given a number", "Bias", "Limits of agreement", "MAE"].map((h) => (
                    <th key={h} className="py-1.5 pr-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(m.subgroups?.[sub] ?? {}).map(([g, s]) => (
                  <tr key={g} className="border-line border-t">
                    <td className="py-1.5 pr-3 align-top font-medium">{groupLabel(sub, g)}</td>
                    <td className="py-1.5 pr-3 align-top">{n.subgroups[sub]?.[g] ?? "—"}</td>
                    <EstimateCell e={s.released} f={percent} />
                    <EstimateCell e={s.bias} f={(v) => dioptres(v, true)} />
                    <td className="py-1.5 pr-3 align-top">
                      {s.loa_low?.value != null && s.loa_high?.value != null
                        ? `${dioptres(s.loa_low.value, true)} to ${dioptres(s.loa_high.value, true)}`
                        : "—"}
                    </td>
                    <EstimateCell e={s.mae} f={(v) => dioptres(v)} />
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <p className="text-muted mt-4 text-xs">
        Report generated {formatDateTime(r.generated_at)} by eyeref-ml v{r.eyeref_ml_version}. Results
        describe this study&apos;s sample.
      </p>
    </>
  );
}

function CrossTableView({ t, unit }: { t: CrossTable; unit: string }) {
  const cell = "border-line border px-3 py-2 text-center";
  return (
    <>
      <table className="num w-full text-xs">
        <thead className="text-muted text-[10px] tracking-wider uppercase">
          <tr>
            <th className="py-1.5 text-left" />
            <th className="py-1.5">Reference: has it</th>
            <th className="py-1.5">Reference: does not</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="py-2 pr-3 text-left font-medium">
              Referred
            </th>
            <td className={cell}>{t.true_positive}</td>
            <td className={cell}>{t.false_positive}</td>
          </tr>
          <tr>
            <th scope="row" className="py-2 pr-3 text-left font-medium">
              Passed
            </th>
            <td className={cell}>{t.false_negative}</td>
            <td className={cell}>{t.true_negative}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-muted mt-2 text-xs">
        {plural(t.not_screened, unit)} could not be screened and {t.not_screened === 1 ? "was" : "were"}{" "}
        referred.
      </p>
    </>
  );
}
