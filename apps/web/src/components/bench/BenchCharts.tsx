"use client";
import {
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BenchReport } from "@/lib/bench/analysis";

const tip = { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12 };
const tick = { fontSize: 11, fill: "var(--muted)" };
const axisLabel = (value: string) => ({ value, fontSize: 10, fill: "var(--muted)" });
const num = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : String(v));

/** Each step's crescent width, turned into dioptres by the model, against the refraction the lens gave. */
export function WidthChart({ report }: { report: BenchReport }) {
  if (!report.predicted) return null;
  const [lo, hi] = report.predicted.deadZoneD;
  const points = report.steps
    .filter((s) => s.inverted)
    .map((s) => ({ x: s.step.refractionD, y: s.inverted!.mean, rot: s.step.rotationDeg }));
  const all = report.steps.map((s) => s.step.refractionD);
  const min = Math.min(...all, lo);
  const max = Math.max(...all, hi);
  return (
    <figure className="space-y-1">
      <div
        className="h-64 w-full"
        role="img"
        aria-label="Crescent width in dioptres against induced refraction"
      >
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 18, left: -4 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="induced"
              unit=" D"
              domain={[Math.floor(min), Math.ceil(max)]}
              tick={tick}
              label={{ ...axisLabel("refraction the lens gives (D)"), dy: 16 }}
            />
            <YAxis type="number" dataKey="y" name="from the width" unit=" D" tick={tick} />
            <Tooltip contentStyle={tip} formatter={num} />
            <ReferenceArea x1={lo} x2={hi} fill="var(--muted)" fillOpacity={0.12} />
            <ReferenceLine
              segment={[
                { x: min, y: min },
                { x: max, y: max },
              ]}
              stroke="var(--muted)"
              strokeDasharray="5 4"
            />
            <Scatter data={points} fill="var(--accent)" isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="text-muted text-xs">
        Dots on the dashed line match the model. The shaded band is the predicted dead zone, where there is no
        crescent to measure.
      </figcaption>
    </figure>
  );
}

/** Inside the dead zone: the brightness slope across the pupil against where the refraction sits in it. */
export function GainChart({ report }: { report: BenchReport }) {
  const g = report.gain;
  if (!g) return null;
  const points = g.points.map(([x, y]) => ({ x, y }));
  const xs = g.points.map(([x]) => x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  return (
    <figure className="space-y-1">
      <div className="h-64 w-full" role="img" aria-label="Brightness slope against position in the dead zone">
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 18, left: -4 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="slope"
              domain={["auto", "auto"]}
              tick={tick}
              tickFormatter={(v: number) => v.toFixed(2)}
              label={{ ...axisLabel("brightness slope across the pupil"), dy: 16 }}
            />
            <YAxis type="number" dataKey="y" name="in half-widths" domain={[-1.2, 1.2]} tick={tick} />
            <Tooltip contentStyle={tip} formatter={num} />
            <ReferenceLine
              segment={[
                { x: x0, y: -g.gain * x0 + g.intercept },
                { x: x1, y: -g.gain * x1 + g.intercept },
              ]}
              stroke="var(--accent)"
            />
            <Scatter data={points} fill="var(--accent-2)" fillOpacity={0.7} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="text-muted text-xs">
        Each frame without a crescent, with the refraction as a fraction of the dead zone&apos;s half-width
        from its centre. The line is the fit; its slope is the gain.
      </figcaption>
    </figure>
  );
}
