import { Check, X } from "lucide-react";
import { DEFAULT_GATING, type GatingConfig } from "@/lib/inference/fusion";
import { countDistinctMeridians } from "@/lib/optics/meridional";
import type { EyeResult } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Explains every gate that decided the output level, with the measured value next to the limit. */
export function WhyPanel({ eye, gating = DEFAULT_GATING }: { eye: EyeResult; gating?: GatingConfig }) {
  const quant = eye.meridians.filter((m) => m.status === "quantitative");
  const half = eye.seCi95 ? (eye.seCi95[1] - eye.seCi95[0]) / 2 : null;
  const distinct = countDistinctMeridians(quant.map((m) => m.meridianDeg));
  const cs = [...(eye.research?.cylSamples ?? [])].sort((a, b) => a - b);
  const q = (p: number) => cs[Math.round(p * (cs.length - 1))]!;
  const cylW = cs.length ? q(0.975) - q(0.025) : null;
  const gates: { label: string; value: string; pass: boolean | null }[] = [
    {
      label: `≥ ${gating.minUsableFramesPerMeridian} usable frames in at least one meridian`,
      value: `${Math.max(0, ...eye.meridians.map((m) => m.nFrames))} best`,
      pass: eye.meridians.some((m) => m.status !== "insufficient"),
    },
    {
      label: `SE 95% half-width ≤ ${gating.maxSeCiHalfwidthQuantitative.toFixed(2)} D (quantitative)`,
      value: half === null ? "—" : `${half.toFixed(2)} D`,
      pass: half === null ? null : half <= gating.maxSeCiHalfwidthQuantitative,
    },
    {
      label: `Class confidence ≥ ${(gating.minClassConfidenceScreening * 100).toFixed(0)}% (screening)`,
      value: eye.confidence === null ? "—" : `${(eye.confidence * 100).toFixed(0)}%`,
      pass: eye.confidence === null ? null : eye.confidence >= gating.minClassConfidenceScreening,
    },
    {
      label: "CYL/AXIS research flag enabled",
      value: gating.astigmatismQuantificationEnabled ? "on" : "off",
      pass: gating.astigmatismQuantificationEnabled,
    },
    {
      label: `≥ ${gating.minDistinctMeridiansForCyl} distinct quantitative meridians`,
      value: String(distinct),
      pass: distinct >= gating.minDistinctMeridiansForCyl,
    },
    {
      label: `CYL 95% width ≤ ${gating.maxCylCiWidth.toFixed(2)} D`,
      value: cylW === null ? "—" : `${cylW.toFixed(2)} D`,
      pass: cylW === null ? null : cylW <= gating.maxCylCiWidth,
    },
    {
      label: `Axis SD ≤ ${gating.maxAxisSdDeg}°`,
      value: eye.research?.axisSdDeg == null ? "—" : `${eye.research.axisSdDeg.toFixed(0)}°`,
      pass: eye.research?.axisSdDeg == null ? null : eye.research.axisSdDeg <= gating.maxAxisSdDeg,
    },
  ];
  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {gates.map((g) => (
          <li key={g.label} className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full",
                g.pass === null ? "bg-line" : g.pass ? "bg-ok text-white" : "bg-bad text-white",
              )}
            >
              {g.pass === true && <Check className="size-3" />}
              {g.pass === false && <X className="size-3" />}
            </span>
            <span className="text-ink-2 flex-1">{g.label}</span>
            <span className="num font-medium">{g.value}</span>
          </li>
        ))}
      </ul>
      <ul className="text-ink-2 list-disc space-y-1 pl-5 text-xs">
        {eye.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
