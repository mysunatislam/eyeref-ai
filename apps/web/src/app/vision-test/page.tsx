"use client";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/field";
import { useSettings } from "@/lib/settings";
import type { VisionTestResult } from "@/lib/types";
import {
  DIRS,
  LETTERS_PER_LINE,
  loadVision,
  MIN_LOGMAR,
  optotypeMm,
  saveVision,
  scoreLogMar,
  snellenFromLogMar,
  START_LOGMAR,
  type Dir,
} from "@/lib/visionTest";

const ROT: Record<Dir, number> = { right: 0, down: 90, left: 180, up: 270 };

function TumblingE({ px, dir }: { px: number; dir: Dir }) {
  // 5x5 grid E, opening facing `dir`
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 5 5"
      style={{ transform: `rotate(${ROT[dir]}deg)` }}
      aria-label="Optotype"
    >
      <path d="M0 0H5V1H1V2H5V3H1V4H5V5H0Z" fill="currentColor" />
    </svg>
  );
}

function AstigmaticDial() {
  return (
    <svg viewBox="-110 -110 220 120" className="w-full max-w-sm" role="img" aria-label="Astigmatic fan chart">
      {Array.from({ length: 13 }, (_, i) => i * 15).map((a) => {
        const r = (a * Math.PI) / 180;
        return (
          <g key={a}>
            {[-3, 0, 3].map((o) => (
              <line
                key={o}
                x1={Math.cos(r) * 20 - Math.sin(r) * o}
                y1={-Math.sin(r) * 20 - Math.cos(r) * o}
                x2={Math.cos(r) * 95 - Math.sin(r) * o}
                y2={-Math.sin(r) * 95 - Math.cos(r) * o}
                stroke="currentColor"
                strokeWidth="1.4"
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

export default function VisionTestPage() {
  const [s] = useSettings();
  const [eye, setEye] = useState<"OD" | "OS" | "OU">("OD");
  const [dist, setDist] = useState(3);
  const [running, setRunning] = useState(false);
  const [lm, setLm] = useState(START_LOGMAR);
  const [k, setK] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [lines, setLines] = useState<{ logMar: number; correct: number }[]>([]);
  const [dir, setDir] = useState<Dir>("right");
  const [result, setResult] = useState<VisionTestResult | null>(null);
  const [dial, setDial] = useState<VisionTestResult["astigmaticDialReport"]>(null);
  const [history, setHistory] = useState<VisionTestResult[]>([]);
  const pxPerMm = s.pxPerMm ?? 3.78;
  const px = optotypeMm(lm, dist) * pxPerMm;
  useEffect(() => {
    let alive = true;
    queueMicrotask(() => alive && setHistory(loadVision()));
    return () => {
      alive = false;
    };
  }, []);

  const finish = useCallback(
    (all: { logMar: number; correct: number }[]) => {
      const score = scoreLogMar(all);
      const r: VisionTestResult = {
        eye,
        logMar: score,
        snellen: score === null ? null : snellenFromLogMar(score),
        distanceM: dist,
        astigmaticDialReport: dial,
        timestamp: new Date().toISOString(),
      };
      setResult(r);
      setRunning(false);
      saveVision(r);
      setHistory(loadVision());
    },
    [eye, dist, dial],
  );

  const answer = useCallback(
    (d: Dir) => {
      if (!running) return;
      const c = correct + (d === dir ? 1 : 0);
      const nk = k + 1;
      setDir(DIRS[Math.floor(Math.random() * 4)]!);
      if (nk < LETTERS_PER_LINE) {
        setK(nk);
        setCorrect(c);
        return;
      }
      const all = [...lines, { logMar: lm, correct: c }];
      setLines(all);
      setK(0);
      setCorrect(0);
      if (c >= 3 && lm - 0.1 >= MIN_LOGMAR - 1e-9 && optotypeMm(lm - 0.1, dist) * pxPerMm >= 5)
        setLm(+(lm - 0.1).toFixed(2));
      else finish(all);
    },
    [running, correct, dir, k, lines, lm, dist, pxPerMm, finish],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m: Record<string, Dir> = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
      };
      if (m[e.key]) {
        e.preventDefault();
        answer(m[e.key]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer]);

  return (
    <>
      <PageHeader
        eyebrow="Separate module"
        title="Vision test"
        description="Tumbling-E visual acuity and an astigmatic fan chart. Acuity is a different measurement from refraction and is never used to compute it."
      />
      {!s.pxPerMm && (
        <p className="border-warn/40 bg-warn-soft text-ink-2 mb-4 rounded-xl border px-4 py-3 text-sm">
          Screen size is not calibrated, so letter sizes are approximate.{" "}
          <Link href="/calibration" className="text-accent font-medium">
            Calibrate the screen
          </Link>{" "}
          first for a meaningful result.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardContent className="flex min-h-[360px] flex-col items-center justify-center gap-6 pt-6">
            {running ? (
              <>
                <div className="num text-muted text-xs">
                  Line logMAR {lm.toFixed(1)} · letter {k + 1}/{LETTERS_PER_LINE}
                </div>
                <div className="text-ink grid min-h-[120px] place-items-center">
                  <TumblingE px={Math.max(px, 5)} dir={dir} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <span />
                  <Button variant="secondary" size="icon" aria-label="Up" onClick={() => answer("up")}>
                    <ArrowUp />
                  </Button>
                  <span />
                  <Button variant="secondary" size="icon" aria-label="Left" onClick={() => answer("left")}>
                    <ArrowLeft />
                  </Button>
                  <Button variant="secondary" size="icon" aria-label="Down" onClick={() => answer("down")}>
                    <ArrowDown />
                  </Button>
                  <Button variant="secondary" size="icon" aria-label="Right" onClick={() => answer("right")}>
                    <ArrowRight />
                  </Button>
                </div>
                <p className="text-muted text-xs">
                  A helper presses the direction the person points to (or use the arrow keys).
                </p>
              </>
            ) : result ? (
              <div className="text-center">
                <div className="text-muted text-xs tracking-wider uppercase">{result.eye} acuity</div>
                <div className="num mt-1 text-4xl font-semibold">
                  {result.logMar === null ? "Below 0.7 logMAR" : `logMAR ${result.logMar.toFixed(2)}`}
                </div>
                {result.snellen && <div className="num text-muted mt-1">Snellen ≈ {result.snellen}</div>}
                <Button className="mt-4" onClick={() => setResult(null)}>
                  Test another eye
                </Button>
              </div>
            ) : (
              <div className="w-full max-w-sm space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Eye (cover the other)">
                    <Select value={eye} onChange={(e) => setEye(e.target.value as "OD" | "OS" | "OU")}>
                      <option value="OD">Right (OD)</option>
                      <option value="OS">Left (OS)</option>
                      <option value="OU">Both</option>
                    </Select>
                  </Field>
                  <Field label="Viewing distance">
                    <Select value={dist} onChange={(e) => setDist(Number(e.target.value))}>
                      <option value={3}>3 m</option>
                      <option value={2}>2 m</option>
                      <option value={1.5}>1.5 m</option>
                    </Select>
                  </Field>
                </div>
                <p className="text-muted text-xs">
                  Wear the usual glasses for distance if you want aided acuity, and note it. Good, even room
                  lighting.
                </p>
                <Button
                  className="w-full"
                  onClick={() => {
                    setLm(START_LOGMAR);
                    setK(0);
                    setCorrect(0);
                    setLines([]);
                    setRunning(true);
                  }}
                >
                  Start acuity test
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Astigmatic fan chart</CardTitle>
                <CardDescription>
                  Look with one eye. Do some lines look darker or sharper than others?
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="text-ink space-y-3">
              <AstigmaticDial />
              <div className="flex flex-wrap gap-2">
                {(["none", "lines_unequal", "unsure"] as const).map((v) => (
                  <Button
                    key={v}
                    size="sm"
                    variant={dial === v ? "primary" : "secondary"}
                    onClick={() => setDial(v)}
                  >
                    {v === "none" ? "All equal" : v === "lines_unequal" ? "Some darker" : "Not sure"}
                  </Button>
                ))}
              </div>
              <p className="text-muted text-[11px]">A subjective hint only. It does not set CYL or AXIS.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent results</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs">
              {history.length === 0 && <p className="text-muted">None yet.</p>}
              {history.slice(0, 8).map((h) => (
                <div
                  key={h.timestamp}
                  className="border-line flex items-center justify-between border-b py-1"
                >
                  <span>
                    {h.eye} · {new Date(h.timestamp).toLocaleDateString()}
                  </span>
                  <span className="num">{h.logMar === null ? "<0.7" : h.logMar.toFixed(2)}</span>
                  {h.astigmaticDialReport === "lines_unequal" && <Badge tone="warn">dial</Badge>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
