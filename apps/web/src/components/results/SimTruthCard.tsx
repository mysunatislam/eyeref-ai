import { FlaskConical } from "lucide-react";
import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAxis, formatDiopters } from "@/lib/optics/powerVector";
import type { EyeSide, OutputLevel, StoredAssessment } from "@/lib/types";

const TONE: Record<OutputLevel, "ok" | "warn" | "bad"> = {
  quantitative: "ok",
  screening: "warn",
  repeat: "bad",
};

type Truth = NonNullable<StoredAssessment["simTruth"]>[EyeSide];

/** The simulated eye's refraction: "−3.00 D sphere", or sphere / cylinder × axis. */
export const truthRx = (t: Truth) =>
  Math.abs(t.cyl) < 0.125
    ? `${formatDiopters(t.sph)} sphere`
    : `${formatDiopters(t.sph)} / ${formatDiopters(t.cyl)} × ${formatAxis(t.axis)}`;

const COLUMNS = ["True refraction", "True SE", "Estimated SE", "Error"] as const;

/**
 * What the simulator rendered next to what the pipeline estimated (Simulation Mode only). A table
 * on wider screens, one card per eye on phones.
 */
export function SimTruthCard({ a }: { a: StoredAssessment }) {
  const truth = a.simTruth;
  if (!a.report.simulated || !truth) return null;
  const rows = (["OD", "OS"] as const).map((eye) => {
    const t = truth[eye];
    const est = a.report.eyes[eye];
    const se = est.outputLevel === "quantitative" ? est.seD : null;
    return {
      eye,
      level: est.outputLevel,
      cells: [
        truthRx(t),
        formatDiopters(t.se),
        se === null ? est.outputLevel : formatDiopters(se),
        se === null ? "—" : formatDiopters(se - t.se),
      ],
    };
  });
  return (
    <Card className="border-sim/40">
      <CardHeader>
        <CardTitle className="text-sim flex items-center gap-2">
          <FlaskConical className="size-4" /> Simulator ground truth (SIMULATED DATA)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="hidden overflow-x-auto sm:block"
          tabIndex={0}
          role="region"
          aria-label="Simulator ground truth table"
        >
          <table className="num w-full text-sm">
            <thead className="text-muted text-left text-[11px] tracking-wider uppercase">
              <tr>
                <th className="py-1 pr-4">Eye</th>
                {COLUMNS.map((c) => (
                  <th key={c} className="pr-4">
                    {c}
                  </th>
                ))}
                <th>Output</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.eye} className="border-line border-t">
                  <td className="py-1.5 pr-4 font-semibold">{r.eye}</td>
                  {r.cells.map((c, i) => (
                    <td key={COLUMNS[i]} className="pr-4">
                      {c}
                    </td>
                  ))}
                  <td>
                    <Badge tone={TONE[r.level]}>{r.level}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 sm:hidden">
          {rows.map((r) => (
            <section
              key={r.eye}
              aria-label={`Simulator ground truth, ${r.eye}`}
              className="border-line rounded-xl border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{r.eye}</span>
                <Badge tone={TONE[r.level]}>{r.level}</Badge>
              </div>
              <dl className="num mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {r.cells.map((c, i) => (
                  <Fragment key={COLUMNS[i]}>
                    <dt className="text-muted">{COLUMNS[i]}</dt>
                    <dd>{c}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="text-muted mt-3 text-xs">
          The simulator models accommodation, so hyperopes are often under-read, as with real undilated eyes.
          This comparison only shows the algorithm is self-consistent; it is not evidence of clinical
          accuracy.
        </p>
      </CardContent>
    </Card>
  );
}
