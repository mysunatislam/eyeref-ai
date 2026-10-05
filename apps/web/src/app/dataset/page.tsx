"use client";
import { CloudUpload, Download, FlaskConical, Loader2, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { download } from "@/components/results/ReportView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { Stat } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import { api, ApiError, connOf } from "@/lib/api";
import { agreement, normalizeGt, pairRows, toCsv } from "@/lib/dataset";
import { formatAxis, formatDiopters, sphericalEquivalent } from "@/lib/optics/powerVector";
import { PROTOCOL_VERSION } from "@/lib/protocol/protocol";
import { useSettings } from "@/lib/settings";
import { saveAssessment } from "@/lib/storage/db";
import { useAssessments } from "@/lib/storage/hooks";
import type { EyeSide, GroundTruthEntry, StoredAssessment } from "@/lib/types";
import { cn, fmt, pct } from "@/lib/utils";

const METHODS: GroundTruthEntry["method"][] = [
  "autorefractor",
  "subjective",
  "cycloplegic",
  "retinoscopy",
  "trial_lens",
];

function GtForm({ onAdd }: { onAdd: (g: GroundTruthEntry) => void }) {
  const [eye, setEye] = useState<EyeSide>("OD");
  const [method, setMethod] = useState<GroundTruthEntry["method"]>("autorefractor");
  const [sph, setSph] = useState("");
  const [cyl, setCyl] = useState("0");
  const [axis, setAxis] = useState("");
  const [instrument, setInstrument] = useState("");
  const s = Number(sph);
  const c = Number(cyl);
  const ax = axis === "" ? null : Number(axis);
  const valid =
    sph !== "" &&
    Number.isFinite(s) &&
    Math.abs(s) <= 25 &&
    Number.isFinite(c) &&
    Math.abs(c) <= 10 &&
    (c === 0 || (ax !== null && ax >= 0 && ax <= 180));
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
      <Field label="Eye">
        <Select value={eye} onChange={(e) => setEye(e.target.value as EyeSide)}>
          <option value="OD">OD (right)</option>
          <option value="OS">OS (left)</option>
        </Select>
      </Field>
      <Field label="Method">
        <Select value={method} onChange={(e) => setMethod(e.target.value as GroundTruthEntry["method"])}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Sphere (D)">
        <Input inputMode="decimal" value={sph} onChange={(e) => setSph(e.target.value)} placeholder="-2.25" />
      </Field>
      <Field label="Cylinder (D)" hint="Plus or minus form">
        <Input inputMode="decimal" value={cyl} onChange={(e) => setCyl(e.target.value)} />
      </Field>
      <Field label="Axis (°)">
        <Input
          inputMode="numeric"
          value={axis}
          onChange={(e) => setAxis(e.target.value)}
          placeholder="1–180"
        />
      </Field>
      <Field label="Instrument">
        <Input value={instrument} onChange={(e) => setInstrument(e.target.value)} placeholder="model" />
      </Field>
      <Button
        className="col-span-2 sm:col-span-6"
        variant="secondary"
        disabled={!valid}
        onClick={() => {
          onAdd(
            normalizeGt({
              eye,
              method,
              sphere: s,
              cylinder: c,
              axis: c === 0 ? null : ax,
              instrument: instrument || undefined,
            }),
          );
          setSph("");
          setCyl("0");
          setAxis("");
        }}
      >
        <Plus /> Add ground truth (stored in minus-cylinder form)
      </Button>
    </div>
  );
}

export default function DatasetPage() {
  const { items, reload } = useAssessments();
  const [s] = useSettings();
  const [incSim, setIncSim] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [consentResearch, setConsentResearch] = useState(false);
  const [consentImages, setConsentImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const list = useMemo(() => (items ?? []).filter((a) => incSim || !a.report.simulated), [items, incSim]);
  const sel = list.find((a) => a.id === selId) ?? list[0] ?? null;
  const rows = useMemo(() => pairRows(list), [list]);
  const agrRel = agreement(rows, "predSe");
  const agrAll = agreement(rows, "posteriorM");

  const update = async (a: StoredAssessment, patch: Partial<StoredAssessment>) => {
    await saveAssessment({ ...a, ...patch });
    reload();
  };

  const upload = async (a: StoredAssessment) => {
    const conn = connOf(s);
    setBusy(true);
    const out: string[] = [];
    const say = (m: string) => (out.push(m), setLog([...out]));
    try {
      const code = a.profile.datasetCode;
      if (!code) throw new Error("Assign a pseudonymous subject code first.");
      const subj = await api.createSubject(conn, {
        code,
        ageGroup: a.profile.ageGroup,
        consentResearch,
        consentImageStorage: consentImages,
        consentVersion: "eyeref-consent-1.0",
        wearsCorrection: a.profile.wearsCorrection,
      });
      say(`Subject ${code} created.`);
      for (const g of a.groundTruth ?? []) await api.addGroundTruth(conn, subj.id, g);
      say(`${a.groundTruth?.length ?? 0} ground-truth entries uploaded.`);
      const ses = await api.createSession(conn, {
        subjectId: subj.id,
        deviceId: a.report.provenance.deviceProfile,
        protocolVersion: PROTOCOL_VERSION,
        simulated: a.report.simulated,
      });
      let n = 0;
      let imgs = 0;
      for (const f of a.frames) {
        const image = consentImages && f.cropDataUrl ? await (await fetch(f.cropDataUrl)).blob() : undefined;
        const r = await api.addCapture(conn, ses.id, {
          metadata: f.metadata,
          features: f.features,
          quality: f.quality,
          image,
        });
        n++;
        if (r.imageStored) imgs++;
      }
      say(
        `${n} captures uploaded (${imgs} with images${imgs ? ", encrypted at rest if the server key is set" : ""}).`,
      );
      await api.addPrediction(conn, ses.id, a.report);
      say("Prediction with model version uploaded. Done.");
    } catch (e) {
      say(`Failed: ${e instanceof ApiError ? `${e.status} ${e.message}` : (e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Mode 2 · Hybrid validation"
        title="Dataset collection"
        description="Pair camera captures with autorefractor or subjective refraction to build the first labelled dataset. Use pseudonymous codes only; never names."
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={!rows.length}
            onClick={() => download(new Blob([toCsv(rows)], { type: "text/csv" }), "eyeref-pairs.csv")}
          >
            <Download /> Export pairs CSV
          </Button>
        }
      />
      <div className="mb-4 flex items-center gap-4">
        <Switch
          checked={incSim}
          onChange={setIncSim}
          label="Include simulated assessments"
          description="For trying the workflow. Simulated rows are flagged in every export."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <Stat label="Assessments" value={list.length} />
        <Stat label="Eyes with ground truth" value={rows.filter((r) => r.gtSe !== null).length} />
        <Stat
          label="SE MAE (released)"
          value={agrRel ? `${agrRel.mae.toFixed(2)} D` : "—"}
          sub={
            agrRel
              ? `n=${agrRel.n} · bias ${agrRel.bias.toFixed(2)} · LoA ${agrRel.loa[0].toFixed(2)}…${agrRel.loa[1].toFixed(2)}`
              : "needs pairs"
          }
        />
        <Stat
          label="SE MAE (all, ungated)"
          value={agrAll ? `${agrAll.mae.toFixed(2)} D` : "—"}
          sub={agrAll ? `n=${agrAll.n} · within ±0.50: ${pct(agrAll.within050)}` : "needs pairs"}
        />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="max-h-[640px] overflow-y-auto">
          {list.length === 0 && (
            <CardContent className="text-muted pt-5 text-sm">
              No {incSim ? "" : "camera "}assessments yet.
            </CardContent>
          )}
          {list.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelId(a.id)}
              className={cn(
                "border-line hover:bg-surface-2 block w-full border-b px-4 py-3 text-left text-sm",
                sel?.id === a.id && "bg-accent-soft",
              )}
            >
              <div className="flex items-center gap-2 font-medium">
                {a.report.simulated && <FlaskConical className="text-sim size-3.5" />}
                {a.profile.datasetCode ?? <span className="text-warn">no code</span>}
                <span className="text-muted text-xs font-normal">{a.profile.label}</span>
              </div>
              <div className="text-muted text-xs">
                {new Date(a.createdAt).toLocaleString()} · GT {a.groundTruth?.length ?? 0}
              </div>
            </button>
          ))}
        </Card>

        {sel && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Subject and ground truth</CardTitle>
                  <CardDescription>
                    Enter the reference refraction measured in the same visit (ideally within 30 minutes, same
                    room).
                  </CardDescription>
                </div>
                {sel.report.simulated && <Badge tone="sim">Simulated</Badge>}
              </CardHeader>
              <CardContent className="space-y-4">
                <Field
                  label="Pseudonymous subject code"
                  hint="e.g. SITE1-0042. Link it to identity only on paper/in your secure study log."
                >
                  <Input
                    defaultValue={sel.profile.datasetCode ?? ""}
                    key={sel.id}
                    onBlur={(e) =>
                      update(sel, {
                        profile: { ...sel.profile, datasetCode: e.target.value.trim() || undefined },
                      })
                    }
                    placeholder="SITE1-0001"
                  />
                </Field>
                <GtForm onAdd={(g) => update(sel, { groundTruth: [...(sel.groundTruth ?? []), g] })} />
                {(sel.groundTruth ?? []).length > 0 && (
                  <table className="num w-full text-xs">
                    <thead className="text-muted text-left text-[10px] tracking-wider uppercase">
                      <tr>
                        <th className="py-1">Eye</th>
                        <th>Method</th>
                        <th>Rx</th>
                        <th>SE</th>
                        <th>Camera</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {sel.groundTruth!.map((g, i) => {
                        const r = sel.report.eyes[g.eye];
                        return (
                          <tr key={i} className="border-line border-t">
                            <td className="py-1">{g.eye}</td>
                            <td>{g.method}</td>
                            <td>
                              {formatDiopters(g.sphere)} / {formatDiopters(g.cylinder)} × {formatAxis(g.axis)}
                            </td>
                            <td>
                              {formatDiopters(
                                sphericalEquivalent({ sph: g.sphere, cyl: g.cylinder, axis: g.axis }),
                              )}
                            </td>
                            <td>
                              {r.outputLevel === "quantitative"
                                ? formatDiopters(r.seD)
                                : `${r.outputLevel} (M ${fmt(r.powerVector?.M, 2)})`}
                            </td>
                            <td className="text-right">
                              <button
                                aria-label="Remove"
                                onClick={() =>
                                  update(sel, { groundTruth: sel.groundTruth!.filter((_, j) => j !== i) })
                                }
                              >
                                <Trash2 className="text-muted size-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Upload to the research server</CardTitle>
                  <CardDescription>
                    Optional. Sends this record to the backend at <code>{s.apiUrl}</code>. Requires written
                    research consent; images only with separate image consent.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <Switch
                  checked={consentResearch}
                  onChange={setConsentResearch}
                  label="Signed research consent on file"
                  description="The server refuses to store anything without it."
                />
                <Switch
                  checked={consentImages}
                  onChange={setConsentImages}
                  label="Separate consent to store eye images"
                  description="Without it, only features, quality and metadata are uploaded."
                />
                <Button
                  onClick={() => upload(sel)}
                  disabled={!consentResearch || busy || !sel.profile.datasetCode}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <CloudUpload />} Upload record
                </Button>
                {log.length > 0 && (
                  <ul className="bg-surface-2 space-y-1 rounded-lg p-3 text-xs">
                    {log.map((l, i) => (
                      <li key={i} className={l.startsWith("Failed") ? "text-bad" : "text-ink-2"}>
                        {l}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
