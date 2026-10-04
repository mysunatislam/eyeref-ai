"use client";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PhotorefractionFeatures } from "@/lib/types";

/** Reflex intensity cross-sections through the pupil: along the light-source meridian and perpendicular. */
export function ProfileChart({ f }: { f: PhotorefractionFeatures }) {
  const n = Math.max(f.profileAlongSource.length, f.profilePerpendicular.length);
  const data = Array.from({ length: n }, (_, i) => ({
    t: +(-0.9 + (1.8 * i) / Math.max(n - 1, 1)).toFixed(2),
    along: f.profileAlongSource[i] ?? null,
    perp: f.profilePerpendicular[i] ?? null,
  }));
  return (
    <div className="h-48 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            label={{
              value: "pupil radius (away ← → towards source)",
              fontSize: 10,
              fill: "var(--muted)",
              position: "insideBottom",
              dy: 8,
            }}
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
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            dataKey="along"
            name="Along source meridian"
            stroke="var(--accent)"
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            dataKey="perp"
            name="Perpendicular"
            stroke="var(--warn)"
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
