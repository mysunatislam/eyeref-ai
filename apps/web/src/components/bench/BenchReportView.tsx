"use client";
import { CheckCircle2, Download, FlaskConical, RotateCcw, Save, XCircle } from "lucide-react";
import { download } from "@/components/results/ReportView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import type { BenchReport, StepSummary } from "@/lib/bench/analysis";
import { runFile, runFileName, type BenchRun } from "@/lib/bench/run";
import { formatDiopters } from "@/lib/optics/powerVector";
import { cn, fmt, formatDateTime } from "@/lib/utils";
import { GainChart, WidthChart } from "./BenchCharts";

const ZONE = { inside: "dead zone", edge: "near an edge", outside: "clear" } as const;
const SIDE = { 1: "light's side", [-1]: "opposite", 0: "—" } as const;

function sideCell(s: StepSummary) {
  if (!s.usable || s.crescentShare === 0) return "—";
  const right = s.zone !== "outside" || s.side === s.expectedSide;
  return (
    <span className={cn(s.zone === "outside" && (right ? "text-ok" : "text-bad font-semibold"))}>
      {SIDE[s.side]}
      {s.zone === "outside" && !right && " (wrong)"}
    </span>
  );
}

/** A bench run's verdict, the checks behind it, and what to do with the gain. */
export function BenchReportView({
  run,
  report,
  canSave,
  saved,
  onSave,
  onRestart,
  onResume,
}: {
  run: BenchRun;
  report: BenchReport;
  /** why the gain cannot be saved, or null when it can */
  canSave: string | null;
  saved: boolean;
  onSave: () => void;
  onRestart: () => void;
  /** back to capturing, for a real run with steps still to take */
  onResume?: () => void;
}) {
  const failed = report.criteria.filter((c) => !c.pass);
  const g = report.gain;
  return (
    <div className="space-y-4">
      <Card className={cn(report.go ? "border-ok/50" : "border-bad/50")}>
        <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            {report.go ? (
              <CheckCircle2 className="text-ok size-9 shrink-0" aria-hidden />
            ) : (
              <XCircle className="text-bad size-9 shrink-0" aria-hidden />
            )}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{report.go ? "Go" : "No go"}</h2>
                {run.simulated && (
                  <Badge tone="sim">
                    <FlaskConical className="size-3" /> Simulated data
                  </Badge>
                )}
              </div>
              <p className="text-ink-2 text-sm">
                {report.go
                  ? `This phone matches the photorefraction model. Its gain inside the dead zone is ${fmt(g?.gain)}.`
                  : `${failed.length} of ${report.criteria.length} checks failed, so the gain must not be used. The checks below say what to fix.`}
              </p>
              <p className="text-muted mt-1 text-xs">
                {run.device.model} · {run.setup.workingDistanceM} m · pupil {run.setup.pupilMm} mm ·{" "}
                {formatDateTime(run.createdAt)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Checks</CardTitle>
              <CardDescription>Stage 0 of the research protocol, and the gain&apos;s fit.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {report.criteria.map((c) => (
                <li key={c.id} className="flex gap-2.5">
                  {c.pass ? (
                    <CheckCircle2 className="text-ok mt-0.5 size-4 shrink-0" aria-label="passed" />
                  ) : (
                    <XCircle className="text-bad mt-0.5 size-4 shrink-0" aria-label="failed" />
                  )}
                  <div>
                    <div className="text-sm font-medium">{c.label}</div>
                    <div className="text-ink-2 text-xs">{c.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>The gain</CardTitle>
              <CardDescription>What goes into the device profile on go.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Gain" value={fmt(g?.gain)} sub={g ? `from ${g.n} frames` : "not fitted"} />
              <Stat label="r" value={fmt(g?.r, 3)} />
              <Stat label="Residual SD" value={fmt(g?.residualSd)} sub="of a half-width" />
              <Stat label="ICC(1,1)" value={fmt(report.icc, 3)} />
              <Stat label="Width slope" value={fmt(report.widthFit?.slope)} sub="1 matches the model" />
              <Stat
                label="Dead zone"
                value={
                  report.observedEdgesD &&
                  report.observedEdgesD[0] !== null &&
                  report.observedEdgesD[1] !== null
                    ? `${fmt(report.observedEdgesD[0])} to ${fmt(report.observedEdgesD[1])}`
                    : "—"
                }
                sub={
                  report.predicted
                    ? `predicted ${fmt(report.predicted.deadZoneD[0])} to ${fmt(report.predicted.deadZoneD[1])}`
                    : undefined
                }
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onSave} disabled={!!canSave || saved}>
                <Save /> {saved ? "Saved to the profile" : `Save to ${run.device.model}`}
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  download(new Blob([runFile(run)], { type: "application/json" }), runFileName(run))
                }
              >
                <Download /> Download the run
              </Button>
            </div>
            {saved && report.calibrated ? (
              <p className="text-ok text-xs" role="status">
                {run.device.model} now uses gain {report.calibrated.gradientGain} (
                {report.calibrated.calibrationVersion}). Dead-zone readings from it are values from now on,
                each with its own interval.
              </p>
            ) : (
              canSave && <p className="text-muted text-xs">{canSave}</p>
            )}
            <p className="text-muted text-xs">
              The file holds every frame&apos;s measurements and no image.{" "}
              <code>python -m eyeref.research.bench_run</code> gives this report from it.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Crescent width against the model</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <WidthChart report={report} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Brightness slope in the dead zone</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {g ? <GainChart report={report} /> : <p className="text-muted text-sm">No gain was fitted.</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Every step</CardTitle>
            <CardDescription>
              Usable frames have a pupil and a quality grade of acceptable or better.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full min-w-[640px] text-left text-xs">
            <caption className="sr-only">Each lens at each rotation, and what its frames showed</caption>
            <thead className="text-muted">
              <tr className="border-line border-b">
                <th className="py-1.5 pr-2 font-medium">Lens</th>
                <th className="pr-2 font-medium">Phone</th>
                <th className="pr-2 font-medium">Model eye</th>
                <th className="pr-2 font-medium">Predicted</th>
                <th className="pr-2 font-medium">Usable</th>
                <th className="pr-2 font-medium">Crescent</th>
                <th className="pr-2 font-medium">Side</th>
                <th className="pr-2 font-medium">Width</th>
                <th className="font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map((s) => (
                <tr key={s.step.index} className="border-line/60 border-b">
                  <td className="py-1.5 pr-2">{formatDiopters(s.step.lensD)}</td>
                  <td className="pr-2">{s.step.rotationDeg}°</td>
                  <td className="pr-2">{formatDiopters(s.step.refractionD)}</td>
                  <td className="pr-2">{ZONE[s.zone]}</td>
                  <td className={cn("pr-2", s.usable === 0 && "text-bad font-semibold")}>
                    {s.usable}/{s.frames}
                  </td>
                  <td className="pr-2">
                    {s.crescentShare === null ? "—" : `${Math.round(s.crescentShare * 100)}%`}
                  </td>
                  <td className="pr-2">{sideCell(s)}</td>
                  <td className="pr-2">
                    {s.widthNorm ? `${Math.round(s.widthNorm.mean * 100)}% of pupil` : "—"}
                  </td>
                  <td>
                    {s.power ? formatDiopters(s.power.mean) : "—"}
                    {s.power?.sd != null && <span className="text-muted"> ± {s.power.sd.toFixed(2)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {onResume && (
          <Button variant="secondary" onClick={onResume}>
            Back to the capture
          </Button>
        )}
        <Button variant="ghost" onClick={onRestart}>
          <RotateCcw /> Start a new run
        </Button>
      </div>
    </div>
  );
}
