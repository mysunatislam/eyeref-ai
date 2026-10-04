"use client";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Field, Input } from "@/components/ui/field";
import { Stat } from "@/components/ui/stat";
import { crescentWidthM, deadZoneInterval } from "@/lib/optics/photorefraction";
import { formatDiopters } from "@/lib/optics/powerVector";

/** Interactive Bobier–Braddick geometry: dead zone and crescent width vs refraction. */
export function DeadZoneCalculator({ defaultEccMm }: { defaultEccMm: number }) {
  const [d, setD] = useState(1.0);
  const [e, setE] = useState(defaultEccMm);
  const [p, setP] = useState(6);
  const g = { workingDistanceM: d, eccentricityM: e / 1000, pupilDiameterM: p / 1000 };
  const ok = d > 0.2 && e > 0.5 && p > 1.5;
  const [lo, hi] = ok ? deadZoneInterval(g) : [0, 0];
  const data = Array.from({ length: 121 }, (_, i) => {
    const R = -8 + i * 0.12;
    const w = ok ? crescentWidthM(R, g) : { widthM: 0, side: 0 };
    return { R: +R.toFixed(2), width: +((w.widthM / g.pupilDiameterM) * 100).toFixed(1) };
  });
  const rows = [0.5, 1, 1.5, 2].map((dd) => {
    const [a, b] = deadZoneInterval({ ...g, workingDistanceM: dd });
    return { dd, a, b };
  });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Distance (m)">
          <Input
            type="number"
            step="0.1"
            min="0.3"
            max="3"
            value={d}
            onChange={(ev) => setD(Number(ev.target.value))}
          />
        </Field>
        <Field label="Source eccentricity (mm)">
          <Input
            type="number"
            step="0.5"
            min="1"
            max="40"
            value={e}
            onChange={(ev) => setE(Number(ev.target.value))}
          />
        </Field>
        <Field label="Pupil (mm)">
          <Input
            type="number"
            step="0.5"
            min="2"
            max="9"
            value={p}
            onChange={(ev) => setP(Number(ev.target.value))}
          />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Dead zone"
          value={`${formatDiopters(lo, 2)} … ${formatDiopters(hi, 2)}`}
          className="col-span-2"
          sub="No crescent forms for refractions in this range"
        />
        <Stat label="Width" value={`${(hi - lo).toFixed(2)} D`} />
      </div>
      <div className="h-52 w-full">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 12, left: -16 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              dataKey="R"
              type="number"
              domain={[-8, 6]}
              tick={{ fontSize: 10, fill: "var(--muted)" }}
              label={{ value: "refraction (D)", fontSize: 10, fill: "var(--muted)", dy: 14 }}
            />
            <YAxis unit="%" tick={{ fontSize: 10, fill: "var(--muted)" }} domain={[0, 100]} />
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: 12,
                fontSize: 12,
              }}
            />
            <ReferenceArea x1={lo} x2={hi} fill="var(--muted)" fillOpacity={0.15} />
            <Line
              dataKey="width"
              name="Crescent width (% pupil)"
              stroke="var(--accent)"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table className="num w-full text-xs">
        <thead className="text-muted text-left text-[10px] tracking-wider uppercase">
          <tr>
            <th className="py-1">Distance</th>
            <th>Dead zone</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.dd} className="border-line border-t">
              <td className="py-1">{r.dd} m</td>
              <td>
                {formatDiopters(r.a)} … {formatDiopters(r.b)}
              </td>
              <td className="text-muted">
                {r.b < 0
                  ? "Emmetropes produce a crescent"
                  : `Myopia beyond ${formatDiopters(r.a)} detectable`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted text-xs">
        The upper edge is (e/p − 1)/d: while the source eccentricity e exceeds the pupil diameter p,
        emmetropia always sits inside the dead zone, whatever the distance. Moving back narrows it (about −1.2
        to +0.2 D at 2 m for a 9 mm flash and 6 mm pupil) at the cost of pixels per pupil. Inside the dead
        zone only the calibrated brightness gradient can give a value.
      </p>
    </div>
  );
}
