"use client";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { RefractionScale } from "@/components/charts/RefractionScale";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { formatAxis, formatDiopters } from "@/lib/optics/powerVector";
import type { AgeGroup, EyeResult, OutputLevel } from "@/lib/types";
import { cn, probability } from "@/lib/utils";

export const LEVEL: Record<OutputLevel, { label: string; tone: "ok" | "warn" | "bad" }> = {
  quantitative: { label: "Quantitative estimate", tone: "ok" },
  screening: { label: "Screening only", tone: "warn" },
  repeat: { label: "Repeat measurement", tone: "bad" },
};

export const CLASS_LABEL = {
  myopia: "Myopia (near-sighted)",
  emmetropia: "No significant error",
  hyperopia: "Hyperopia (far-sighted)",
} as const;

export function EyeResultCard({ eye, ageGroup }: { eye: EyeResult; ageGroup: AgeGroup }) {
  const [open, setOpen] = useState(false);
  const lv = LEVEL[eye.outputLevel];
  const ci = eye.seCi95;
  return (
    <Card className="overflow-hidden">
      <CardHeader className="items-center">
        <div>
          <div className="text-muted text-[11px] font-semibold tracking-[0.14em] uppercase">
            {eye.eye === "OD" ? "Right eye · OD" : "Left eye · OS"}
          </div>
          <div className="text-ink-2 mt-1 text-sm">{eye.message}</div>
        </div>
        <Badge tone={lv.tone} className="shrink-0">
          {lv.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        {eye.outputLevel === "quantitative" && eye.seD !== null ? (
          <div>
            <div className="text-muted text-[10px] font-semibold tracking-[0.12em] uppercase">
              Spherical equivalent
            </div>
            <div className="num mt-1 text-4xl font-semibold tracking-tight">{formatDiopters(eye.seD)}</div>
            {ci && (
              <div className="num text-muted mt-1 text-xs">
                95% interval {formatDiopters(ci[0])} to {formatDiopters(ci[1])}
              </div>
            )}
          </div>
        ) : eye.outputLevel === "screening" && eye.refractiveClass ? (
          <div>
            <div className="text-muted text-[10px] font-semibold tracking-[0.12em] uppercase">
              Screening classification
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight">
              {CLASS_LABEL[eye.refractiveClass]}
            </div>
            <div className="text-muted mt-1 text-xs">
              No dioptre value is shown because the uncertainty is too wide for a number to be meaningful.
            </div>
          </div>
        ) : (
          <div>
            <div className="text-bad text-2xl font-semibold tracking-tight">Insufficient confidence</div>
            <div className="text-muted mt-1 text-xs">
              Nothing is estimated from this capture. Follow the guidance and repeat.
            </div>
          </div>
        )}

        {eye.outputLevel !== "repeat" && <RefractionScale eye={eye} ageGroup={ageGroup} />}

        {eye.classProbabilities && (
          <div className="space-y-1.5">
            {(["myopia", "emmetropia", "hyperopia"] as const).map((k) => (
              <div key={k} className="flex items-center gap-3 text-xs">
                <span className="text-ink-2 w-24 shrink-0 capitalize">{k}</span>
                <Progress
                  value={eye.classProbabilities![k]}
                  tone={k === "emmetropia" ? "ok" : k === "myopia" ? "accent" : "warn"}
                  label={`${k} probability`}
                />
                <span className="num w-12 shrink-0 text-right">
                  {probability(eye.classProbabilities![k])}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="border-line grid grid-cols-3 gap-4 border-t pt-4">
          <Stat
            label="Confidence"
            value={probability(eye.confidence)}
            tone={eye.confidence !== null && eye.confidence >= 0.8 ? "ok" : "warn"}
          />
          <Stat label="Image quality" value={<span className="capitalize">{eye.qualityGrade ?? "—"}</span>} />
          <Stat label="Usable frames" value={`${eye.nUsableFrames}/${eye.nFrames}`} />
        </div>

        <div className="border-line bg-surface-2 rounded-xl border p-3">
          <div className="text-muted text-[10px] font-semibold tracking-[0.12em] uppercase">
            Astigmatism (CYL / AXIS)
          </div>
          {eye.astigmatismStatus === "quantified" && eye.cylD !== null ? (
            <div className="num mt-1 grid grid-cols-3 gap-2 text-sm">
              <div>
                SPH <b>{formatDiopters(eye.sphD)}</b>
              </div>
              <div>
                CYL <b>{formatDiopters(eye.cylD)}</b>
              </div>
              <div>
                AXIS <b>{formatAxis(eye.axisDeg)}</b>
                {eye.axisUncertaintyDeg !== null && (
                  <span className="text-muted"> ±{eye.axisUncertaintyDeg.toFixed(0)}°</span>
                )}
              </div>
              <div className="text-warn col-span-3 text-xs">
                Research flag enabled: astigmatism values are not clinically validated.
              </div>
            </div>
          ) : (
            <div className="text-ink-2 mt-1 text-xs">
              {eye.astigmatismStatus === "screening_only"
                ? `Not quantified. Probability of ≥ 0.75 D astigmatism: ${probability(eye.astigmatismProbability)} (screening signal only).`
                : "Not assessed. CYL/AXIS requires validated multi-meridian data and is gated off by default."}
            </div>
          )}
        </div>

        {eye.notes.length > 0 && (
          <div>
            <button
              onClick={() => setOpen((o) => !o)}
              className="text-ink-2 flex items-center gap-1 text-xs font-medium"
              aria-expanded={open}
            >
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} /> Why this
              result ({eye.notes.length} notes)
            </button>
            {open && (
              <ul className="text-ink-2 mt-2 list-disc space-y-1 pl-5 text-xs">
                {eye.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
