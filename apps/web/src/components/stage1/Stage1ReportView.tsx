"use client";
import { CheckCircle2, CircleDashed, Download, FlaskConical, XCircle } from "lucide-react";
import { download } from "@/components/results/ReportView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { formatDiopters } from "@/lib/optics/powerVector";
import {
  describeFocus,
  stage1File,
  stage1FileName,
  type Stage1Data,
  type Stage1Report,
} from "@/lib/research/stage1";
import { cn, fmt, formatDateTime, pct, plural } from "@/lib/utils";
import { Stage1Chart } from "./Stage1Chart";

const interval = (ci: [number, number] | null, digits = 2) =>
  ci ? `95% CI ${ci[0].toFixed(digits)} to ${ci[1].toFixed(digits)}` : "one person so far";

/** What stage 1 has shown so far, and whether it passes the protocol's go/no-go. */
export function Stage1ReportView({ data, report }: { data: Stage1Data; report: Stage1Report }) {
  const f = report.fit;
  const v = report.verdict;
  const Icon = v === "go" ? CheckCircle2 : v === "no_go" ? XCircle : CircleDashed;
  return (
    <div className="space-y-4">
      <Card className={cn(v === "go" ? "border-ok/50" : v === "no_go" ? "border-bad/50" : "border-line")}>
        <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center">
          <Icon
            className={cn(
              "size-9 shrink-0",
              v === "go" ? "text-ok" : v === "no_go" ? "text-bad" : "text-muted",
            )}
            aria-hidden
          />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">
                {v === "go" ? "Go" : v === "no_go" ? "No go" : "Still collecting"}
              </h2>
              {report.simulated && (
                <Badge tone="sim">
                  <FlaskConical className="size-3" /> Simulated data
                </Badge>
              )}
            </div>
            <p className="text-ink-2 text-sm">
              {v === "go"
                ? "The app measures the change each lens makes, within the protocol's limits. Collecting a dataset can follow."
                : v === "no_go"
                  ? "Enough people, but a criterion failed. Fix capture and optics before collecting a dataset."
                  : `${plural(report.complete, "participant")} through the whole series so far. The criteria below are read as they stand.`}
            </p>
            <p className="text-muted mt-1 text-xs">
              {plural(report.captures, "capture")} from {plural(report.people, "participant", "participants")}{" "}
              · {report.devices.join(", ") || "no device"} · {formatDateTime(data.createdAt)}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Checks</CardTitle>
              <CardDescription>
                Stage 1 of the research protocol: the slope, repeatability and quality.
              </CardDescription>
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
              <CardTitle>The numbers</CardTitle>
              <CardDescription>Every interval treats each person as one, not each eye.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Slope" value={fmt(f?.slope)} sub={f ? interval(f.slopeCi95) : "no fit yet"} />
              <Stat
                label="Relaxed baseline"
                value={f ? formatDiopters(f.intercept) : "—"}
                sub={f ? `${interval(f.interceptCi95)}, each eye's line at no lens` : undefined}
              />
              <Stat label="Within-eye SD" value={fmt(f?.withinSdD)} sub="D, around each eye's line" />
              <Stat label="Repeatability" value={fmt(f?.repeatabilityD)} sub="D between two captures, 95%" />
              <Stat label="ICC(1,1)" value={fmt(f?.icc, 3)} sub="lens removed" />
              <Stat
                label="Released"
                value={pct(report.quality.releasedShare)}
                sub={`${report.quality.released} of ${report.quality.eyeCaptures} eye-captures`}
              />
            </div>
            {report.focus && <p className="text-ink-2 text-xs">{describeFocus(report.focus)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={!report.captures}
                onClick={() =>
                  download(new Blob([stage1File(data)], { type: "application/json" }), stage1FileName(data))
                }
              >
                <Download /> Download the data
              </Button>
            </div>
            <p className="text-muted text-xs">
              The file holds each capture&apos;s lens and what the app released, and no image.{" "}
              <code>python -m eyeref.research.stage1</code> gives this report from it.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>What each eye measured</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {f ? (
            <Stage1Chart report={report} />
          ) : (
            <p className="text-muted text-sm">
              Nothing to plot yet: it needs an eye with a number at two fogging lenses.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Every lens</CardTitle>
            <CardDescription>
              A fogging lens puts the light beyond the eye&apos;s far point, so the eye cannot focus through
              it. Only those give the slope.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto" tabIndex={0} role="region" aria-label="Lens table">
          <table className="num w-full min-w-[620px] text-xs">
            <thead className="text-muted text-left text-[10px] tracking-wider uppercase">
              <tr>
                {["Lens", "Change at the eye", "Role", "Captures", "Passed", "Released", "Mean M"].map(
                  (h) => (
                    <th key={h} className="py-1.5 pr-3">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {report.lenses.map((r) => (
                <tr key={r.lensD} className="border-line border-t">
                  <td className="py-1.5 pr-3">{formatDiopters(r.lensD)}</td>
                  <td className="py-1.5 pr-3">{formatDiopters(r.inducedD)}</td>
                  <td className="py-1.5 pr-3">
                    {r.lensD === 0
                      ? "no lens"
                      : r.roles.in_reach > r.roles.fogging
                        ? "within reach"
                        : "fogging"}
                  </td>
                  <td className="py-1.5 pr-3">{r.captures}</td>
                  <td className="py-1.5 pr-3">
                    {r.passed}/{r.eyeCaptures}
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.released}/{r.eyeCaptures}
                  </td>
                  <td className="py-1.5 pr-3">{r.meanM === null ? "—" : formatDiopters(r.meanM)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
