"use client";
import {
  CartesianGrid,
  ErrorBar,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { StoredAssessment } from "@/lib/types";
import { UI_LOCALE } from "@/lib/utils";

/** Longitudinal SE per eye. Only quantitative outputs are plotted; screening-only points are omitted. */
export function TrendChart({ items }: { items: StoredAssessment[] }) {
  const rows = [...items]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((a) => {
      const pt = (e: "OD" | "OS") => {
        const r = a.report.eyes[e];
        if (r.outputLevel !== "quantitative" || r.seD === null || !r.seCi95) return {};
        return { [e]: r.seD, [`${e}err`]: [r.seD - r.seCi95[0], r.seCi95[1] - r.seD] };
      };
      return {
        t: new Date(a.createdAt).toLocaleDateString(UI_LOCALE, { month: "short", day: "numeric" }),
        ...pt("OD"),
        ...pt("OS"),
      };
    });
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis dataKey="t" tick={{ fontSize: 11, fill: "var(--muted)" }} />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} unit=" D" domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              fontSize: 12,
            }}
            formatter={(v) => (typeof v === "number" ? `${v.toFixed(2)} D` : String(v))}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            type="monotone"
            dataKey="OD"
            name="OD (right)"
            stroke="var(--accent)"
            strokeWidth={2}
            connectNulls
            dot={{ r: 3 }}
          >
            <ErrorBar dataKey="ODerr" stroke="var(--accent)" width={4} />
          </Line>
          <Line
            type="monotone"
            dataKey="OS"
            name="OS (left)"
            stroke="var(--accent-2)"
            strokeWidth={2}
            connectNulls
            dot={{ r: 3 }}
          >
            <ErrorBar dataKey="OSerr" stroke="var(--accent-2)" width={4} />
          </Line>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
