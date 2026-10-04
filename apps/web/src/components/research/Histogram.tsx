"use client";
import { Bar, BarChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function Histogram({
  samples,
  bins = 30,
  color = "var(--accent)",
  truth,
  unit = " D",
}: {
  samples: number[];
  bins?: number;
  color?: string;
  truth?: number | null;
  unit?: string;
}) {
  if (!samples.length) return <p className="text-muted text-xs">No samples.</p>;
  let lo = Math.min(...samples);
  let hi = Math.max(...samples);
  if (truth !== null && truth !== undefined) {
    lo = Math.min(lo, truth);
    hi = Math.max(hi, truth);
  }
  const w = Math.max((hi - lo) / bins, 1e-6);
  const data = Array.from({ length: bins }, (_, i) => ({ x: +(lo + (i + 0.5) * w).toFixed(2), n: 0 }));
  for (const s of samples) data[Math.min(bins - 1, Math.floor((s - lo) / w))]!.n++;
  return (
    <div className="h-36 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -28 }} barCategoryGap={1}>
          <XAxis
            dataKey="x"
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            unit={unit}
            interval={Math.floor(bins / 5)}
          />
          <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} />
          <Tooltip
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              fontSize: 12,
            }}
          />
          <Bar dataKey="n" fill={color} isAnimationActive={false} />
          {truth !== null && truth !== undefined && (
            <ReferenceLine
              x={data.reduce((b, d) => (Math.abs(d.x - truth) < Math.abs(b.x - truth) ? d : b)).x}
              stroke="var(--sim)"
              strokeDasharray="4 3"
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
