"use client";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AxisPolar } from "@/components/research/AxisPolar";
import { FrameInspector } from "@/components/research/FrameInspector";
import { Histogram } from "@/components/research/Histogram";
import { MeridionalChart } from "@/components/research/MeridionalChart";
import { WhyPanel } from "@/components/research/WhyPanel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Stat } from "@/components/ui/stat";
import { Tabs } from "@/components/ui/tabs";
import { isUsable } from "@/lib/cv/quality";
import { DEFAULT_GATING } from "@/lib/inference/fusion";
import { formatAxis, formatDiopters } from "@/lib/optics/powerVector";
import { useSettings } from "@/lib/settings";
import { useAssessments } from "@/lib/storage/hooks";
import type { EyeSide } from "@/lib/types";
import { cn, fmt } from "@/lib/utils";

function Research() {
  const { items } = useAssessments();
  const params = useSearchParams();
  const router = useRouter();
  const [s] = useSettings();
  const [eyeSide, setEye] = useState<EyeSide>("OD");
  const [sel, setSel] = useState(0);
  const a = useMemo(() => {
    if (!items?.length) return null;
    const id = params.get("id");
    return items.find((x) => x.id === id) ?? items[0]!;
  }, [items, params]);
  if (items === null) return <p className="text-muted text-sm">Loading…</p>;
  if (!a)
    return (
      <Card>
        <CardContent className="pt-5 text-sm">
          No assessments stored on this device yet. Run one in{" "}
          <Link href="/assess" className="text-accent">
            Assess
          </Link>{" "}
          (Simulation Mode works without a camera).
        </CardContent>
      </Card>
    );
  const eye = a.report.eyes[eyeSide];
  const frames = a.frames.filter((f) => f.metadata.eye === eyeSide);
  const frame = frames[Math.min(sel, frames.length - 1)];
  const truth = a.simTruth?.[eyeSide] ?? null;
  const pv = eye.powerVector;
  const pvsd = eye.powerVectorSd;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          className="max-w-sm"
          value={a.id}
          onChange={(e) => (router.replace(`/research?id=${encodeURIComponent(e.target.value)}`), setSel(0))}
          aria-label="Assessment"
        >
          {items.map((x) => (
            <option key={x.id} value={x.id}>
              {x.report.simulated ? "[SIM] " : ""}
              {x.profile.label} · {new Date(x.createdAt).toLocaleString()}
            </option>
          ))}
        </Select>
        <Tabs
          value={eyeSide}
          onChange={(v) => (setEye(v), setSel(0))}
          items={[
            { value: "OD", label: "OD · right" },
            { value: "OS", label: "OS · left" },
          ]}
        />
        {a.report.simulated && (
          <Badge tone="sim">
            <FlaskConical className="size-3" /> Simulated data
          </Badge>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Meridional power</CardTitle>
              <CardDescription>
                Each usable frame measures power along one meridian. The curve is the Bayesian M/J0/J45
                posterior mean.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <MeridionalChart eye={eye} frames={frames.filter((f) => isUsable(f.quality))} truth={truth} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Power vector</CardTitle>
            <Badge
              tone={
                eye.outputLevel === "quantitative" ? "ok" : eye.outputLevel === "screening" ? "warn" : "bad"
              }
            >
              {eye.outputLevel}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Stat
                label="M"
                value={pv ? pv.M.toFixed(2) : "—"}
                sub={pvsd ? `± ${pvsd.M.toFixed(2)}` : undefined}
              />
              <Stat
                label="J0"
                value={pv ? pv.J0.toFixed(2) : "—"}
                sub={pvsd ? `± ${pvsd.J0.toFixed(2)}` : undefined}
              />
              <Stat
                label="J45"
                value={pv ? pv.J45.toFixed(2) : "—"}
                sub={pvsd ? `± ${pvsd.J45.toFixed(2)}` : undefined}
              />
            </div>
            <div className="border-warn/50 bg-warn-soft rounded-xl border border-dashed p-3 text-xs">
              <div className="text-warn font-semibold">Ungated research view</div>
              <div className="num text-ink mt-1">
                {eye.research
                  ? `${formatDiopters(eye.research.sph)} / ${formatDiopters(eye.research.cyl)} × ${formatAxis(eye.research.axis)}`
                  : "—"}
              </div>
              <div className="text-ink-2 mt-1">
                Posterior point estimate shown for investigators only. It is never displayed to patients
                unless every gate passes and the research flag is on.
              </div>
            </div>
            {truth && (
              <div className="text-sim text-xs">
                Truth: {formatDiopters(truth.sph)} / {formatDiopters(truth.cyl)} × {formatAxis(truth.axis)}{" "}
                (SE {formatDiopters(truth.se)})
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Axis posterior</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center">
            <AxisPolar samples={eye.research?.axisSamples ?? []} truth={truth?.axis} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Sphere posterior</CardTitle>
          </CardHeader>
          <CardContent>
            <Histogram samples={eye.research?.sphSamples ?? []} truth={truth?.sph} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cylinder posterior</CardTitle>
          </CardHeader>
          <CardContent>
            <Histogram samples={eye.research?.cylSamples ?? []} truth={truth?.cyl} color="var(--accent-2)" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Why this output</CardTitle>
            <CardDescription>Every gate between the measurements and what the person sees.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <WhyPanel
            eye={eye}
            gating={{ ...DEFAULT_GATING, astigmatismQuantificationEnabled: s.astigmatismQuantification }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Raw image inspection</CardTitle>
            <CardDescription>
              Select a frame. Overlays are drawn from the exact masks and features the estimator used.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {frames.map((f, i) => (
              <button
                key={i}
                onClick={() => setSel(i)}
                className={cn(
                  "relative size-14 shrink-0 overflow-hidden rounded-lg border-2 bg-black",
                  i === sel ? "border-accent" : isUsable(f.quality) ? "border-ok/50" : "border-bad/60",
                )}
                aria-label={`Frame ${i + 1}`}
              >
                {f.cropDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local data URL, nothing to optimise
                  <img src={f.cropDataUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-[10px] text-white/60">{i + 1}</span>
                )}
                <span className="absolute right-0 bottom-0 bg-black/70 px-1 text-[9px] text-white">
                  {fmt(f.estimate?.meridianDeg, 0)}°
                </span>
              </button>
            ))}
          </div>
          {frame && <FrameInspector frame={frame} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Frame table</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="num w-full min-w-[640px] text-xs">
            <thead className="text-muted text-left text-[10px] tracking-wider uppercase">
              <tr>
                {[
                  "#",
                  "Meridian",
                  "Grade",
                  "Score",
                  "Pupil mm",
                  "Crescent",
                  "Width %",
                  "Status",
                  "Power",
                  "σ",
                  "Truth",
                ].map((h) => (
                  <th key={h} className="py-1 pr-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {frames.map((f, i) => (
                <tr
                  key={i}
                  onClick={() => setSel(i)}
                  className={cn(
                    "border-line hover:bg-surface-2 cursor-pointer border-t",
                    i === sel && "bg-accent-soft",
                  )}
                >
                  <td className="py-1 pr-3">{f.metadata.frameIndex}</td>
                  <td className="pr-3">{fmt(f.estimate?.meridianDeg, 0)}</td>
                  <td className="pr-3">{f.quality.grade}</td>
                  <td className="pr-3">{(f.quality.score * 100).toFixed(0)}</td>
                  <td className="pr-3">{fmt(f.features.pupilDiameterMm, 2)}</td>
                  <td className="pr-3">
                    {f.features.crescentPresent ? (f.features.crescentSide > 0 ? "+" : "−") : "·"}
                  </td>
                  <td className="pr-3">
                    {f.features.crescentPresent ? (f.features.crescentWidthNorm * 100).toFixed(0) : "—"}
                  </td>
                  <td className="pr-3">{f.estimate?.status ?? "rejected"}</td>
                  <td className="pr-3">{fmt(f.estimate?.powerD, 2)}</td>
                  <td className="pr-3">{fmt(f.estimate?.sigmaD, 2)}</td>
                  <td className="text-sim pr-3">{fmt(f.simTruth?.powerInMeridianD, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ResearchPage() {
  return (
    <>
      <PageHeader
        eyebrow="Investigator"
        title="Research dashboard"
        description="Everything behind a result: raw crops, masks, profiles, per-frame estimates, the posterior and the gates."
      />
      <Suspense fallback={<p className="text-muted text-sm">Loading…</p>}>
        <Research />
      </Suspense>
    </>
  );
}
