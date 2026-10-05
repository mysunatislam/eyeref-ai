"use client";
import { AlertTriangle, Download, FileText, FlaskConical, Microscope, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { formatAxis, formatDiopters } from "@/lib/optics/powerVector";
import { deleteAssessment, exportJson } from "@/lib/storage/db";
import type { StoredAssessment } from "@/lib/types";
import { AGE_LABEL, cn, pct } from "@/lib/utils";
import { AiExplainPanel } from "./AiExplainPanel";
import { EyeResultCard } from "./EyeResultCard";

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReportView({ a }: { a: StoredAssessment }) {
  const r = a.report;
  const router = useRouter();
  const urgent = r.referralReasons.length > 0;
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {r.simulated && (
              <Badge tone="sim">
                <FlaskConical className="size-3" /> Simulated data
              </Badge>
            )}
            <Badge>{AGE_LABEL[a.profile.ageGroup]}</Badge>
            <Badge>{new Date(a.createdAt).toLocaleString()}</Badge>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            Screening report · {a.profile.label}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/report?id=${encodeURIComponent(a.id)}`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <FileText /> Referral report
          </Link>
          <Link
            href={`/research?id=${encodeURIComponent(a.id)}`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <Microscope /> Research view
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => download(exportJson([a]), `eyeref-${a.id}.json`)}
          >
            <Download /> Export
          </Button>
          <Link href="/assess" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <RotateCcw /> Repeat
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              if (!confirm("Delete this assessment and its images from this device?")) return;
              await deleteAssessment(a.id);
              router.push("/history");
            }}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      <Card className={cn(urgent ? "border-warn/50" : "border-line")}>
        <CardContent className="flex gap-3 pt-5">
          <AlertTriangle className={cn("mt-0.5 size-5 shrink-0", urgent ? "text-warn" : "text-muted")} />
          <div className="space-y-2 text-sm">
            <p className="font-medium">{r.interpretation}</p>
            {urgent && (
              <ul className="text-ink-2 list-disc space-y-1 pl-5">
                {r.referralReasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <EyeResultCard eye={r.eyes.OD} ageGroup={a.profile.ageGroup} />
        <EyeResultCard eye={r.eyes.OS} ageGroup={a.profile.ageGroup} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Both eyes</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="SE difference"
            value={
              r.seDifferenceD === null ? "—" : formatDiopters(Math.abs(r.seDifferenceD)).replace("+", "")
            }
          />
          <Stat
            label="Anisometropia ≥ 1 D"
            value={pct(r.anisometropiaProbability)}
            tone={(r.anisometropiaProbability ?? 0) > 0.5 ? "warn" : undefined}
            sub="probability"
          />
          <Stat
            label="Reflex brightness ratio"
            value={r.reflexAsymmetryRatio === null ? "—" : r.reflexAsymmetryRatio.toFixed(2)}
            tone={r.reflexAsymmetryFlag ? "bad" : undefined}
            sub={r.reflexAsymmetryFlag ? "asymmetric: refer" : "OD vs OS"}
          />
          <Stat
            label="Frames used"
            value={`${r.eyes.OD.nUsableFrames + r.eyes.OS.nUsableFrames}/${r.eyes.OD.nFrames + r.eyes.OS.nFrames}`}
          />
        </CardContent>
      </Card>

      {r.simulated && a.simTruth && (
        <Card className="border-sim/40">
          <CardHeader>
            <CardTitle className="text-sim flex items-center gap-2">
              <FlaskConical className="size-4" /> Simulator ground truth (SIMULATED DATA)
            </CardTitle>
          </CardHeader>
          <CardContent
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Simulator ground truth table"
          >
            <table className="num w-full text-sm">
              <thead className="text-muted text-left text-[11px] tracking-wider uppercase">
                <tr>
                  <th className="py-1 pr-4">Eye</th>
                  <th className="pr-4">True Rx</th>
                  <th className="pr-4">True SE</th>
                  <th className="pr-4">Estimated SE</th>
                  <th className="pr-4">Error</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {(["OD", "OS"] as const).map((e) => {
                  const t = a.simTruth![e];
                  const est = r.eyes[e];
                  const err = est.seD !== null && est.outputLevel === "quantitative" ? est.seD - t.se : null;
                  return (
                    <tr key={e} className="border-line border-t">
                      <td className="py-1.5 pr-4 font-semibold">{e}</td>
                      <td className="pr-4">
                        {formatDiopters(t.sph)} / {formatDiopters(t.cyl)} × {formatAxis(t.axis)}
                      </td>
                      <td className="pr-4">{formatDiopters(t.se)}</td>
                      <td className="pr-4">
                        {est.outputLevel === "quantitative" ? formatDiopters(est.seD) : est.outputLevel}
                      </td>
                      <td className="pr-4">{err === null ? "—" : formatDiopters(err)}</td>
                      <td>
                        <Badge
                          tone={
                            est.outputLevel === "quantitative"
                              ? "ok"
                              : est.outputLevel === "screening"
                                ? "warn"
                                : "bad"
                          }
                        >
                          {est.outputLevel}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-muted mt-2 text-xs">
              The simulator models accommodation, so hyperopes are often under-read, as with real undilated
              eyes. This comparison only shows the algorithm is self-consistent; it is not evidence of
              clinical accuracy.
            </p>
          </CardContent>
        </Card>
      )}

      <AiExplainPanel report={r} />

      <Card>
        <CardHeader>
          <CardTitle>Provenance</CardTitle>
        </CardHeader>
        <CardContent className="text-ink-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div>
            Estimator: {r.provenance.modelName} v{r.provenance.modelVersion} ({r.provenance.estimatorKind})
          </div>
          <div>Feature extractor: {r.provenance.extractorVersion}</div>
          <div>Device profile: {r.provenance.deviceProfile}</div>
          <div>Calibration: {r.provenance.calibrationVersion}</div>
          <div>App: v{r.provenance.appVersion}</div>
          <div>Report id: {r.id}</div>
        </CardContent>
      </Card>

      <p className="border-line bg-surface-2 text-ink-2 rounded-xl border px-4 py-3 text-xs">
        {r.disclaimer}
      </p>
    </div>
  );
}
