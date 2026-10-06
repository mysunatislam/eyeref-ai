"use client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { pct } from "@/lib/utils";
import type { EyeMetrics, ValidationReport } from "@/lib/validationReport";
import { MODEL_LABEL } from "@/lib/validationReport";

const tip = { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12 };
const tick = { fontSize: 11, fill: "var(--muted)" };

export function BlandAltman({
  ba,
}: {
  ba: Pick<EyeMetrics["bland_altman_se"], "mean_diff" | "loa_low" | "loa_high" | "points">;
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 12, left: -8 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="mean"
            name="mean"
            unit=" D"
            tick={tick}
            label={{ value: "mean of methods (D)", fontSize: 10, fill: "var(--muted)", dy: 14 }}
          />
          <YAxis type="number" dataKey="diff" name="diff" unit=" D" tick={tick} />
          <Tooltip contentStyle={tip} formatter={(v) => (typeof v === "number" ? v.toFixed(2) : String(v))} />
          <ReferenceLine
            y={ba.mean_diff}
            stroke="var(--accent)"
            label={{
              value: `bias ${ba.mean_diff.toFixed(2)}`,
              fontSize: 10,
              fill: "var(--accent)",
              position: "insideTopRight",
            }}
          />
          <ReferenceLine y={ba.loa_low} stroke="var(--warn)" strokeDasharray="5 4" />
          <ReferenceLine y={ba.loa_high} stroke="var(--warn)" strokeDasharray="5 4" />
          <Scatter data={ba.points} fill="var(--accent-2)" fillOpacity={0.6} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RocChart({ roc }: { roc: { fpr: number; tpr: number }[] }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <LineChart data={roc} margin={{ top: 8, right: 12, bottom: 12, left: -16 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="fpr"
            domain={[0, 1]}
            tick={tick}
            label={{ value: "1 − specificity", fontSize: 10, fill: "var(--muted)", dy: 14 }}
          />
          <YAxis type="number" domain={[0, 1]} tick={tick} />
          <Tooltip contentStyle={tip} />
          <Line dataKey="tpr" stroke="var(--accent)" dot={false} strokeWidth={2} isAnimationActive={false} />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke="var(--line)"
            strokeDasharray="4 4"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Selective prediction: releasing eyes from the most certain, the MAE of those released so far against the
 * share of eyes released. The dot is where the product's own gate stopped.
 */
export function RiskCoverageChart({
  curve,
  gate,
}: {
  curve: { coverage: number; mae: number }[];
  gate: { coverage: number; mae: number } | null;
}) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <LineChart data={curve} margin={{ top: 16, right: 16, bottom: 12, left: -8 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="coverage"
            domain={[0, 1]}
            tick={tick}
            tickFormatter={(v: number) => pct(v)}
            label={{ value: "share of eyes released", fontSize: 10, fill: "var(--muted)", dy: 14 }}
          />
          <YAxis type="number" unit=" D" tick={tick} domain={[0, "auto"]} />
          <Tooltip
            contentStyle={tip}
            labelFormatter={(v) => (typeof v === "number" ? `${pct(v)} released` : String(v))}
            formatter={(v) => (typeof v === "number" ? `${v.toFixed(2)} D` : String(v))}
          />
          <Line
            dataKey="mae"
            name="MAE"
            stroke="var(--accent)"
            dot={false}
            strokeWidth={2}
            isAnimationActive={false}
          />
          {gate && (
            <ReferenceDot
              x={gate.coverage}
              y={gate.mae}
              r={5}
              fill="var(--warn)"
              stroke="var(--surface)"
              label={{ value: "the app's gate", position: "top", fontSize: 10, fill: "var(--warn)" }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Reliability diagram: mean predicted probability against observed frequency, one point per bin. */
export function ReliabilityChart({
  bins,
}: {
  bins: { predicted: number; observed: number; eyes: number }[];
}) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 8, right: 12, bottom: 12, left: -16 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="predicted"
            name="predicted"
            domain={[0, 1]}
            tick={tick}
            label={{ value: "predicted probability", fontSize: 10, fill: "var(--muted)", dy: 14 }}
          />
          <YAxis type="number" dataKey="observed" name="observed" domain={[0, 1]} tick={tick} />
          <ZAxis type="number" dataKey="eyes" name="eyes" range={[30, 300]} />
          <Tooltip
            contentStyle={tip}
            formatter={(v) => (typeof v === "number" ? +v.toFixed(2) : String(v))}
          />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke="var(--line)"
            strokeDasharray="4 4"
          />
          <Scatter
            data={bins}
            fill="var(--accent)"
            line={{ stroke: "var(--accent)" }}
            isAnimationActive={false}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DegradationChart({ r }: { r: ValidationReport }) {
  const data = Object.entries(r.cross_device_degradation).map(([k, v]) => ({
    model: MODEL_LABEL[k] ?? k,
    seen: +v.in_distribution_mae.toFixed(3),
    unseen: +v.unseen_device_mae.toFixed(3),
  }));
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 60 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis type="number" unit=" D" tick={tick} />
          <YAxis type="category" dataKey="model" tick={{ ...tick, fontSize: 10 }} width={120} />
          <Tooltip contentStyle={tip} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar
            dataKey="seen"
            name="Devices seen in training"
            fill="var(--accent)"
            isAnimationActive={false}
          />
          <Bar dataKey="unseen" name="Held-out device" fill="var(--warn)" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
