"use client";
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Stage1Report } from "@/lib/research/stage1";

const tip = { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12 };
const tick = { fontSize: 11, fill: "var(--muted)" };
const axisLabel = (value: string) => ({ value, fontSize: 10, fill: "var(--muted)" });
const num = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : String(v));

/**
 * The change each eye measured against the change its lens made. Each eye is shown relative to its own
 * line at no added lens, so every eye shares one line: the dashed line is the ideal, where the app measures
 * exactly what the lens did.
 */
export function Stage1Chart({ report }: { report: Stage1Report }) {
  const fit = report.fit;
  if (!fit) return null;
  const pt = (p: { x: number; y: number; baselineD: number | null; code: string; eye: string }) =>
    p.baselineD === null ? null : { x: p.x, y: p.y - p.baselineD, who: `${p.code} ${p.eye}` };
  const fogging = fit.points.map(pt).filter((v): v is NonNullable<typeof v> => v !== null);
  const check = (report.focus?.points ?? []).map(pt).filter((v): v is NonNullable<typeof v> => v !== null);
  const xs = [...fogging, ...check].map((p) => p.x);
  const lo = Math.min(...xs, 0);
  const hi = Math.max(...xs, 0);
  return (
    <figure className="space-y-1">
      <div className="h-64 w-full" role="img" aria-label="Measured change against the lens's change">
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 18, left: -4 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="the lens"
              unit=" D"
              domain={[Math.floor(lo), Math.ceil(hi)]}
              tick={tick}
              label={{ ...axisLabel("change the lens makes (D)"), dy: 16 }}
            />
            <YAxis type="number" dataKey="y" name="measured" unit=" D" tick={tick} />
            <Tooltip contentStyle={tip} formatter={num} />
            <ReferenceLine
              segment={[
                { x: lo, y: lo },
                { x: hi, y: hi },
              ]}
              stroke="var(--muted)"
              strokeDasharray="5 4"
            />
            <ReferenceLine
              segment={[
                { x: lo, y: fit.slope * lo },
                { x: hi, y: fit.slope * hi },
              ]}
              stroke="var(--accent)"
            />
            <Scatter name="fogging" data={fogging} fill="var(--accent)" isAnimationActive={false} />
            <Scatter name="no lens" data={check} fill="var(--warn)" isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="text-muted text-xs">
        Blue: the fogging lenses, which the eye cannot focus through. The solid line is their fit, the dashed
        line the ideal. Amber at zero: the same eyes with no added lens, where they focus on the light.
      </figcaption>
    </figure>
  );
}
