"use client";
import { Eye, FastForward, FlaskConical, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { rgbaToDataUrl } from "@/lib/cv/draw";
import { DEFAULT_GATING } from "@/lib/inference/fusion";
import {
  buildProtocol,
  captureSimulatedFrame,
  COUNTDOWN_S,
  estimatorFor,
  FRAME_INTERVAL_MS,
  type CapturedEye,
} from "@/lib/protocol/protocol";
import { evaluateReadiness } from "@/lib/protocol/readiness";
import { useSettings } from "@/lib/settings";
import type { VirtualSubject } from "@/lib/simulation/session";
import type { FrameRecord } from "@/lib/types";
import { Countdown } from "./Countdown";
import { EyeCanvas } from "./EyeCanvas";
import { Indicators } from "./Indicators";
import type { Phase } from "./LiveStage";
import { MeridianDial } from "./MeridianDial";
import { PrepareChecklist } from "./PrepareChecklist";
import { StepSummary } from "./StepSummary";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulation Mode capture: same protocol and pipeline as the camera, on rendered virtual eyes. */
export function SimStage({
  phase,
  subject,
  onPhase,
  onComplete,
}: {
  phase: Phase;
  subject: VirtualSubject;
  onPhase: (p: Phase) => void;
  onComplete: (frames: FrameRecord[]) => void;
}) {
  const [s] = useSettings();
  const estimator = useMemo(() => estimatorFor("physics"), []);
  const steps = useMemo(() => buildProtocol(s.meridians), [s.meridians]);
  const [sessionSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const [stepIdx, setStepIdx] = useState(0);
  const [frames, setFrames] = useState<FrameRecord[]>([]);
  const [captured, setView] = useState<CapturedEye[] | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [simDistance, setSimDistance] = useState(1.6);
  const counter = useRef(0);
  const step = steps[Math.min(stepIdx, steps.length - 1)]!;

  const preview = useMemo(
    () => captureSimulatedFrame(subject, 0, 9999, sessionSeed, estimator, s.targetDistanceM),
    [subject, sessionSeed, estimator, s.targetDistanceM],
  );

  useEffect(() => {
    if (phase !== "distance") return;
    const id = setInterval(() => setSimDistance((d) => d + (s.targetDistanceM - d) * 0.25), 200);
    return () => clearInterval(id);
  }, [phase, s.targetDistanceM]);

  const view = captured ?? preview;
  const od = view?.find((v) => v.eye === "OD");
  const meta = od?.record.metadata;
  const readiness = evaluateReadiness({
    face: true,
    distanceM: phase === "distance" ? simDistance : (meta?.workingDistanceM ?? null),
    targetDistanceM: s.targetDistanceM,
    luma: 0.16,
    yawDeg: meta?.headPose.yawDeg ?? 0,
    pitchDeg: meta?.headPose.pitchDeg ?? 0,
    rollDeg: meta?.headPose.rollDeg ?? 0,
    gaze: 0.03,
    blink: od && od.record.quality.hardFailures.includes("pupil_occluded") ? 0.9 : 0.05,
    motionPx: meta?.motionPxPerFrame ?? null,
    pupilMm: od?.record.features.pupilDiameterMm ?? null,
    grade: od?.record.quality.grade ?? null,
    flashAvailable: true,
    deviceRotationErrorDeg: phase === "capture" ? 0 : null,
  });

  const runStep = async (idx: number, fast = false) => {
    const st = steps[idx]!;
    if (!fast)
      for (let c = COUNTDOWN_S; c > 0; c--) {
        setCount(c);
        await sleep(450);
      }
    setCount(null);
    const recs: FrameRecord[] = [];
    for (let i = 0; i < s.framesPerMeridian; i++) {
      const eyes = captureSimulatedFrame(
        subject,
        st.rotationDeg,
        counter.current++,
        sessionSeed,
        estimator,
        s.targetDistanceM,
      );
      setView(eyes);
      for (const e of eyes)
        recs.push({
          ...e.record,
          protocolRotationDeg: st.rotationDeg,
          cropDataUrl: s.storeCrops ? rgbaToDataUrl(e.image) : undefined,
        });
      await sleep(fast ? 30 : FRAME_INTERVAL_MS * 2);
    }
    setFrames((f) => [...f.filter((x) => x.protocolRotationDeg !== st.rotationDeg), ...recs]);
    return recs;
  };

  const captureOne = async () => {
    setBusy(true);
    try {
      await runStep(stepIdx);
      if (stepIdx < steps.length - 1) setStepIdx(stepIdx + 1);
    } finally {
      setBusy(false);
    }
  };

  const runAll = async () => {
    setBusy(true);
    try {
      for (let i = stepIdx; i < steps.length; i++) {
        setStepIdx(i);
        await runStep(i, true);
      }
    } finally {
      setBusy(false);
    }
  };

  const allDone = steps.every((st) => frames.some((f) => f.protocolRotationDeg === st.rotationDeg));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <div className="border-sim/40 relative overflow-hidden rounded-2xl border bg-[#07080c] p-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-white/80">
            <FlaskConical className="text-sim size-4" />
            <span className="text-sim font-bold tracking-wider">SIMULATED DATA</span>
            <span className="text-white/60">
              Rendered virtual eyes, processed by the real on-device pipeline.
            </span>
          </div>
          <div className="relative grid grid-cols-2 gap-3">
            {/* Image-left is the subject's right eye (OD) in a non-mirrored camera frame. */}
            <EyeCanvas
              image={od?.image ?? null}
              features={od?.record.features}
              segmentation={od?.segmentation}
              label="OD · right eye"
            />
            <EyeCanvas
              image={view?.find((v) => v.eye === "OS")?.image ?? null}
              features={view?.find((v) => v.eye === "OS")?.record.features}
              segmentation={view?.find((v) => v.eye === "OS")?.segmentation}
              label="OS · left eye"
            />
            <Countdown value={count} />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {view?.map((v) => (
              <Badge key={v.eye} className="bg-white/10 text-white">
                {v.eye}: {v.record.quality.grade} · pupil{" "}
                {v.record.features.pupilDiameterMm?.toFixed(1) ?? "—"} mm ·{" "}
                {v.record.features.crescentPresent
                  ? `crescent ${(v.record.features.crescentWidthNorm * 100).toFixed(0)}%`
                  : "no crescent"}
              </Badge>
            ))}
          </div>
        </div>
        <p className="text-muted text-xs">
          Overlays: cyan = pupil fit, dashed blue = iris, yellow = detected crescent, orange = light-source
          direction, white cross = corneal glint.
        </p>
      </div>

      <div className="space-y-4">
        {phase === "prepare" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Preparation and lighting check</CardTitle>
                <CardDescription>
                  In Simulation Mode the room is simulated as dim (good). The checklist is what a real capture
                  needs.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <PrepareChecklist />
              <Indicators
                compact
                items={readiness.indicators.filter((i) =>
                  ["face", "light", "pupil", "flash"].includes(i.key),
                )}
              />
              <Button className="w-full" onClick={() => onPhase("distance")}>
                Continue to distance
              </Button>
            </CardContent>
          </Card>
        )}
        {phase === "distance" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Distance calibration</CardTitle>
                <CardDescription>
                  Target {s.targetDistanceM.toFixed(1)} m. Simulated helper walking into position.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="num text-center text-5xl font-semibold">{simDistance.toFixed(2)} m</div>
              <Indicators
                compact
                items={readiness.indicators.filter((i) => ["distance", "pose", "motion"].includes(i.key))}
              />
              <Button
                className="w-full"
                onClick={() => onPhase("capture")}
                disabled={Math.abs(simDistance - s.targetDistanceM) > 0.1}
              >
                Continue to capture
              </Button>
            </CardContent>
          </Card>
        )}
        {phase === "capture" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>
                  Meridian {stepIdx + 1} of {steps.length}
                </CardTitle>
                <CardDescription>
                  Each device rotation measures refraction along a different meridian. Four angles allow a
                  power-vector fit.
                </CardDescription>
              </div>
              <MeridianDial target={step.rotationDeg} measured={step.rotationDeg} size={92} />
            </CardHeader>
            <CardContent className="space-y-4">
              <Indicators compact items={readiness.indicators} />
              <div className="flex gap-2">
                <Button size="lg" className="flex-1" disabled={busy} onClick={captureOne}>
                  {busy ? <Loader2 className="animate-spin" /> : <Eye />} Capture
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  disabled={busy}
                  onClick={runAll}
                  title="Capture all remaining angles"
                >
                  <FastForward /> All
                </Button>
              </div>
              <StepSummary
                steps={steps}
                frames={frames}
                current={stepIdx}
                minUsable={DEFAULT_GATING.minUsableFramesPerMeridian}
              />
              <Button
                className="w-full"
                disabled={!frames.length || busy}
                variant={allDone ? "primary" : "subtle"}
                onClick={() => onComplete(frames)}
              >
                {allDone ? "Analyse" : "Analyse with the angles captured so far"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
