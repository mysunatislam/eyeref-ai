"use client";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { powerInMeridian, toPowerVector } from "@/lib/optics/powerVector";
import type { EyeResult, FrameRecord, SphCylAxisLike } from "./types";

/** Per-frame meridional powers vs meridian, with the fitted P(θ) = M + J0·cos2θ + J45·sin2θ curve. */
export function MeridionalChart({
  eye,
  frames,
  truth,
}: {
  eye: EyeResult;
  frames: FrameRecord[];
  truth?: SphCylAxisLike | null;
}) {
  const pts = frames
    .filter(
      (f) =>
        f.estimate?.status === "quantitative" &&
        f.estimate.powerD !== null &&
        f.estimate.meridianDeg !== null,
    )
    .map((f) => ({ m: f.estimate!.meridianDeg!, p: f.estimate!.powerD! }));
  const ivs = eye.meridians
    .filter((m) => m.status === "interval" && m.intervalD)
    .flatMap((m) => [
      { m: m.meridianDeg, lo: m.intervalD![0] },
      { m: m.meridianDeg, hi: m.intervalD![1] },
    ]);
  const curve = Array.from({ length: 37 }, (_, i) => {
    const th = i * 5;
    const row: Record<string, number> = { m: th };
    if (eye.powerVector) row.fit = powerInMeridian(eye.powerVector, th);
    if (truth)
      row.truth = powerInMeridian(toPowerVector({ sph: truth.sph, cyl: truth.cyl, axis: truth.axis }), th);
    return row;
  });
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <ComposedChart margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="m"
            domain={[0, 180]}
            ticks={[0, 45, 90, 135, 180]}
            unit="°"
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            allowDuplicatedCategory={false}
          />
          <YAxis
            type="number"
            unit=" D"
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            data={curve}
            dataKey="fit"
            name="Posterior fit"
            stroke="var(--accent)"
            dot={false}
            strokeWidth={2}
            isAnimationActive={false}
          />
          {truth && (
            <Line
              data={curve}
              dataKey="truth"
              name="Simulator truth"
              stroke="var(--sim)"
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
          <Scatter data={pts} dataKey="p" name="Frame estimates" fill="var(--accent-2)" />
          {ivs.length > 0 && (
            <Scatter data={ivs} dataKey="lo" name="Dead-zone bounds" fill="var(--muted)" shape="cross" />
          )}
          {ivs.length > 0 && (
            <Scatter data={ivs} dataKey="hi" legendType="none" fill="var(--muted)" shape="cross" />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
