"use client";
import { FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Stat } from "@/components/ui/stat";
import { Tabs } from "@/components/ui/tabs";
import { BlandAltman, DegradationChart, RocChart } from "@/components/validation/Charts";
import { cn, fmt, pct } from "@/lib/utils";
import { MODEL_LABEL, type Reg, type ValidationReport } from "@/lib/validationReport";

const d = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v.toFixed(2)} D`);

export default function ValidationPage() {
  const [r, setR] = useState<ValidationReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [exp, setExp] = useState("subject_split");
  const [model, setModel] = useState("random_forest");
  const [sub, setSub] = useState("device_id");
  useEffect(() => {
    fetch("/reports/validation_report.json")
      .then((x) => (x.ok ? x.json() : Promise.reject(new Error(`${x.status}`))))
      .then((j: ValidationReport) => setR(j))
      .catch(() =>
        setErr(
          "No validation report found. Run `make ml-train` to generate ml/reports/latest and publish it to the web app.",
        ),
      );
  }, []);

  if (err) return <p className="text-muted text-sm">{err}</p>;
  if (!r) return <p className="text-muted text-sm">Loading report…</p>;
  const e = r.experiments[exp]!;
  const models = Object.keys(e.models);
  const m = e.models[model] ?? e.models[models[0]!]!;
  const em = m.eye;
  const subgroups = m.subgroups ?? e.models.random_forest?.subgroups;

  return (
    <>
      <PageHeader
        eyebrow="Validation"
        title="Model comparison and validation"
        description="Subject-level splits (no person in both train and test), leave-one-device-out, conformal uncertainty, gating and rejection analysis."
      />
      {r.simulated && (
        <div className="sim-stripes border-sim/40 mb-5 flex items-start gap-3 rounded-2xl border p-4 text-sm">
          <FlaskConical className="text-sim mt-0.5 size-5 shrink-0" />
          <div>
            <div className="text-sim font-bold tracking-wider">SIMULATED VALIDATION RESULTS</div>
            <p className="text-ink-2 mt-1 first-letter:uppercase">
              {r.warning.replace(/^SIMULATED DATA\s*[-–]\s*/, "")} {r.dataset.n_subjects} virtual subjects,{" "}
              {r.dataset.n_frames.toLocaleString()} rendered frames, {r.dataset.devices.length} simulated
              devices. Real performance is unknown until the clinical protocol in docs/VALIDATION_PROTOCOL.md
              is run.
            </p>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs
          value={exp}
          onChange={setExp}
          items={Object.keys(r.experiments).map((k) => ({
            value: k,
            label:
              k === "subject_split"
                ? "Subject split"
                : `Unseen device (${r.experiments[k]!.held_out_device ?? ""})`,
          }))}
        />
        <span className="text-muted text-xs">
          {e.description} · {e.n_test_subjects} test subjects
        </span>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <div>
            <CardTitle>Spherical equivalent, all models</CardTitle>
            <CardDescription>
              “All eyes” uses the ungated posterior mean for every eye. “Released” counts only eyes the gate
              allowed a number for. Classical baselines come first on purpose.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full min-w-[760px] text-xs">
            <thead className="text-muted text-left text-[10px] tracking-wider uppercase">
              <tr>
                {[
                  "Model",
                  "MAE all",
                  "MAE released",
                  "RMSE",
                  "±0.25",
                  "±0.50",
                  "±1.00",
                  "Released",
                  "CI cover",
                  "Myopia sens/spec",
                  "AUC",
                ].map((h) => (
                  <th key={h} className="py-1.5 pr-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map((k) => {
                const x = e.models[k]!.eye;
                const best = models.every(
                  (o) => (e.models[o]!.eye.se_all_eyes.mae ?? 9) >= (x.se_all_eyes.mae ?? 9),
                );
                return (
                  <tr
                    key={k}
                    onClick={() => setModel(k)}
                    className={cn(
                      "border-line hover:bg-surface-2 cursor-pointer border-t",
                      k === model && "bg-accent-soft",
                    )}
                  >
                    <td className="py-1.5 pr-3 font-medium">
                      {MODEL_LABEL[k] ?? k} {best && <Badge tone="ok">best</Badge>}
                    </td>
                    <td className="pr-3">{d(x.se_all_eyes.mae)}</td>
                    <td className="pr-3">{d(x.se_released_only.mae)}</td>
                    <td className="pr-3">{d(x.se_all_eyes.rmse)}</td>
                    <td className="pr-3">{pct(x.se_all_eyes.within_0_25)}</td>
                    <td className="pr-3">{pct(x.se_all_eyes.within_0_50)}</td>
                    <td className="pr-3">{pct(x.se_all_eyes.within_1_00)}</td>
                    <td className="pr-3">{pct(x.output_levels.quantitative)}</td>
                    <td className="pr-3">{pct(x.se_ci95_coverage)}</td>
                    <td className="pr-3">
                      {pct(x.screening_myopia.sensitivity)} / {pct(x.screening_myopia.specificity)}
                    </td>
                    <td>{fmt(x.screening_myopia.roc_auc, 3)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">Details for</span>
        <Select className="max-w-xs" value={model} onChange={(ev) => setModel(ev.target.value)}>
          {models.map((k) => (
            <option key={k} value={k}>
              {MODEL_LABEL[k] ?? k}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Bland–Altman (SE)</CardTitle>
              <CardDescription>
                Bias {d(em.bland_altman_se.mean_diff)} · 95% limits of agreement{" "}
                {d(em.bland_altman_se.loa_low)} to {d(em.bland_altman_se.loa_high)}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <BlandAltman ba={em.bland_altman_se} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Myopia screening ROC</CardTitle>
              <CardDescription>
                AUC {fmt(em.screening_myopia.roc_auc, 3)} · prevalence {pct(em.screening_myopia.prevalence)}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {em.screening_myopia.roc ? (
              <RocChart roc={em.screening_myopia.roc} />
            ) : (
              <p className="text-muted text-xs">No ROC points.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Screening</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            {(
              ["screening_myopia", "screening_hyperopia", "screening_astigmatism", "anisometropia"] as const
            ).map((k) => {
              const s = em[k];
              return (
                <div key={k} className="border-line grid grid-cols-5 gap-2 border-b pb-2">
                  <span className="col-span-5 font-medium capitalize">
                    {k.replace("screening_", "").replace("_", " ")}
                  </span>
                  <Stat label="Sens" value={pct(s.sensitivity)} className="[&>div:nth-child(2)]:text-sm" />
                  <Stat label="Spec" value={pct(s.specificity)} className="[&>div:nth-child(2)]:text-sm" />
                  <Stat label="PPV" value={pct(s.ppv)} className="[&>div:nth-child(2)]:text-sm" />
                  <Stat label="NPV" value={pct(s.npv)} className="[&>div:nth-child(2)]:text-sm" />
                  <Stat label="AUC" value={fmt(s.roc_auc, 2)} className="[&>div:nth-child(2)]:text-sm" />
                </div>
              );
            })}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Astigmatism and axis</CardTitle>
              <CardDescription>
                Axis error is circular (179° vs 1° = 2°), computed only where |CYL| ≥ 0.75 D.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <Stat label="Cylinder MAE" value={d(em.cylinder.mae)} />
            <Stat label="J0 / J45 MAE" value={`${fmt(em.J0.mae, 2)} / ${fmt(em.J45.mae, 2)}`} />
            <Stat
              label="Axis mean error"
              value={em.axis.mean_abs_error_deg === null ? "—" : `${em.axis.mean_abs_error_deg.toFixed(1)}°`}
              sub={`n = ${em.axis.n}`}
            />
            <Stat label="Axis within 10°" value={pct(em.axis.within_10)} />
            <p className="text-warn col-span-2 text-xs">
              CYL/AXIS stays gated off in the app until these hold on real multi-meridian data.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Quality-based rejection</CardTitle>
              <CardDescription>
                Frame error if each grade were used. Rejected frames are much worse, which justifies the gate.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {(["excellent", "acceptable", "poor", "reject"] as const).map((g) => {
              const v = em.rejection[g] as { fraction: number; mae_if_used: number | null } | undefined;
              return (
                <div key={g} className="border-line flex items-center justify-between border-b py-1">
                  <span className="capitalize">{g}</span>
                  <span className="num">
                    {pct(v?.fraction, 1)} of frames · MAE {d(v?.mae_if_used)}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <div>
            <CardTitle>Cross-device generalisation</CardTitle>
            <CardDescription>
              Trained on three simulated phones, tested on a fourth with different flash offset, gain, noise
              and resolution. Learned models lose more than physics; this is why every new phone needs bench
              calibration.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <DegradationChart r={r} />
        </CardContent>
      </Card>

      {subgroups && (
        <Card className="mt-4">
          <CardHeader>
            <div>
              <CardTitle>Subgroups</CardTitle>
              <CardDescription>
                Performance by device, age, refractive range, pupil size, distance and skin-tone index of the
                renderer.
              </CardDescription>
            </div>
            <Select className="max-w-[180px]" value={sub} onChange={(ev) => setSub(ev.target.value)}>
              {Object.keys(subgroups).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="num w-full min-w-[520px] text-xs">
              <thead className="text-muted text-left text-[10px] tracking-wider uppercase">
                <tr>
                  {["Group", "n", "MAE", "Bias", "±0.50", "Released"].map((h) => (
                    <th key={h} className="py-1 pr-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(subgroups[sub] ?? {}).map(([g, v]: [string, Reg]) => (
                  <tr key={g} className="border-line border-t">
                    <td className="py-1 pr-3">{g}</td>
                    <td className="pr-3">{v.n}</td>
                    <td className="pr-3">{d(v.mae)}</td>
                    <td className="pr-3">{d(v.bias)}</td>
                    <td className="pr-3">{pct(v.within_0_50)}</td>
                    <td className="pr-3">{pct(v.fraction_quantitative)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!m.subgroups && (
              <p className="text-muted mt-2 text-xs">
                Shown for the random forest (subgroups not computed for this model).
              </p>
            )}
          </CardContent>
        </Card>
      )}
      <p className="text-muted mt-4 text-xs">
        Report generated {new Date(r.generated_at).toLocaleString()} by eyeref-ml v{r.eyeref_ml_version}.
      </p>
    </>
  );
}
