"use client";
import { Camera, Eye, Flashlight, Loader2, RefreshCw, ScanFace } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { useDeviceRotation } from "@/lib/camera/useDeviceRotation";
import { rgbaToDataUrl } from "@/lib/cv/draw";
import { isUsable } from "@/lib/cv/quality";
import { DEFAULT_GATING } from "@/lib/inference/fusion";
import { activeDevice, buildProtocol, COUNTDOWN_S, estimatorFor } from "@/lib/protocol/protocol";
import { evaluateReadiness, rotationError } from "@/lib/protocol/readiness";
import { useSettings } from "@/lib/settings";
import { HVID_MM } from "@/lib/tracking/eyeGeometry";
import { useLiveTracker } from "@/lib/tracking/useLiveTracker";
import type { FrameRecord, SubjectProfile } from "@/lib/types";
import { Countdown } from "./Countdown";
import { Indicators, TopHint } from "./Indicators";
import { MeridianDial } from "./MeridianDial";
import { PrepareChecklist } from "./PrepareChecklist";
import { StepSummary } from "./StepSummary";

export type Phase = "prepare" | "distance" | "capture";

export function LiveStage({
  phase,
  profile,
  onPhase,
  onComplete,
}: {
  phase: Phase;
  profile: SubjectProfile;
  onPhase: (p: Phase) => void;
  onComplete: (frames: FrameRecord[]) => void;
}) {
  const [s] = useSettings();
  const device = activeDevice(s);
  const estimator = useMemo(() => estimatorFor("physics"), []);
  const steps = useMemo(() => buildProtocol(s.meridians), [s.meridians]);
  const [stepIdx, setStepIdx] = useState(0);
  const [manualD, setManualD] = useState<number | null>(null);
  const [useManual, setUseManual] = useState(false);
  const rotation = useDeviceRotation();
  const step = steps[Math.min(stepIdx, steps.length - 1)]!;
  const measuredRot = rotation.rollDeg === null ? null : ((rotation.rollDeg % 180) + 180) % 180;
  const ctx = useMemo(
    () => ({
      device,
      hfovDeg: s.hfovDeg ?? device.hfovDeg,
      hvidMm: s.personalHvidMm ?? HVID_MM,
      ageGroup: profile.ageGroup,
      manualDistanceM: useManual ? manualD : null,
    }),
    [device, s.hfovDeg, s.personalHvidMm, profile.ageGroup, useManual, manualD],
  );
  const {
    videoRef,
    overlayRef,
    status,
    error,
    facing,
    caps,
    torchOn,
    startCamera: start,
    stopCamera,
    lmStatus,
    lmError,
    ensureLandmarker,
    telemetry: t,
    captureBurst,
    showLandmarks,
    setShowLandmarks,
  } = useLiveTracker(ctx, estimator, measuredRot ?? step.rotationDeg);
  const [frames, setFrames] = useState<FrameRecord[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [prepOk, setPrepOk] = useState(false);
  const frameCounter = useRef(0);

  const startCamera = useCallback(async () => {
    await ensureLandmarker();
    await start(device.camera === "rear" ? "environment" : "user");
  }, [ensureLandmarker, start, device.camera]);

  const flashAvailable = device.flashOffsetMm !== null && (device.camera !== "rear" || Boolean(caps?.torch));
  const readiness = evaluateReadiness({
    face: t.face,
    distanceM: t.distanceM,
    targetDistanceM: s.targetDistanceM,
    luma: t.luma,
    yawDeg: t.yawDeg,
    pitchDeg: t.pitchDeg,
    rollDeg: t.rollDeg,
    gaze: t.gaze,
    blink: t.blink,
    motionPx: t.motionPx,
    pupilMm: t.pupilMm.OD ?? t.pupilMm.OS,
    grade: t.grade.OD,
    flashAvailable,
    deviceRotationErrorDeg:
      phase === "capture" && measuredRot !== null ? rotationError(measuredRot, step.rotationDeg) : null,
  });

  const capture = async () => {
    setCapturing(true);
    for (let c = COUNTDOWN_S; c > 0; c--) {
      setCount(c);
      await new Promise((r) => setTimeout(r, 800));
    }
    setCount(null);
    try {
      const burst = await captureBurst(s.framesPerMeridian, frameCounter.current);
      frameCounter.current += s.framesPerMeridian;
      const keep = s.storeCrops && profile.consentImages;
      const recs = burst.flat().map((p) => ({
        ...p.record,
        protocolRotationDeg: step.rotationDeg,
        cropDataUrl: keep ? rgbaToDataUrl(p.image) : undefined,
      }));
      setFrames((f) => [...f.filter((x) => x.protocolRotationDeg !== step.rotationDeg), ...recs]);
      const good = (eye: "OD" | "OS") =>
        recs.filter((r) => r.metadata.eye === eye && isUsable(r.quality)).length >=
        DEFAULT_GATING.minUsableFramesPerMeridian;
      if (good("OD") && good("OS") && stepIdx < steps.length - 1) setStepIdx((i) => i + 1);
    } finally {
      setCapturing(false);
    }
  };

  const allDone = steps.every((st) => frames.some((f) => f.protocolRotationDeg === st.rotationDeg));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <div
          className="border-line relative overflow-hidden rounded-2xl border bg-black"
          data-camera={status}
          data-landmarker={lmStatus}
        >
          <div className="relative aspect-video w-full">
            <video
              ref={videoRef}
              playsInline
              muted
              className="absolute inset-0 h-full w-full object-contain"
              style={{ transform: facing === "user" ? "scaleX(-1)" : undefined }}
            />
            <canvas
              ref={overlayRef}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              style={{ transform: facing === "user" ? "scaleX(-1)" : undefined }}
            />
            <Countdown value={count} />
            {status !== "live" && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
                <div className="max-w-sm space-y-3">
                  <ScanFace className="mx-auto size-10 opacity-80" />
                  <p className="text-sm text-white/80">
                    The camera feed is analysed on this device. Nothing is uploaded. Landmarks are used for
                    geometry only; there is no face recognition.
                  </p>
                  {error && <p className="text-sm text-red-300">{error}</p>}
                  {lmError && <p className="text-sm text-red-300">{lmError}</p>}
                  <Button onClick={startCamera} disabled={status === "requesting" || lmStatus === "loading"}>
                    {status === "requesting" || lmStatus === "loading" ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Camera />
                    )}
                    Start camera
                  </Button>
                </div>
              </div>
            )}
            {status === "live" && (
              <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
                <Badge className="bg-black/60 text-white">
                  {caps ? `${caps.width}×${caps.height}` : "—"}
                </Badge>
                <Badge className="bg-black/60 text-white">{t.fps.toFixed(0)} fps</Badge>
                {t.irisPx !== null && (
                  <Badge className={t.irisPx < 30 ? "bg-bad/80 text-white" : "bg-black/60 text-white"}>
                    iris {t.irisPx.toFixed(0)} px
                  </Badge>
                )}
                {torchOn && (
                  <Badge className="bg-warn text-white">
                    <Flashlight className="size-3" /> pulse
                  </Badge>
                )}
              </div>
            )}
          </div>
        </div>
        {status === "live" && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <TopHint items={readiness.indicators} />
            <label className="text-muted ml-auto flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showLandmarks}
                onChange={(e) => setShowLandmarks(e.target.checked)}
              />{" "}
              landmarks
            </label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => start(facing === "user" ? "environment" : "user")}
            >
              <RefreshCw /> Switch camera
            </Button>
          </div>
        )}
        {t.irisPx !== null && t.irisPx < 30 && (
          <p className="border-warn/40 bg-warn-soft text-ink-2 rounded-xl border px-3 py-2 text-xs">
            The iris spans only {t.irisPx.toFixed(0)} pixels, so the pupil is under{" "}
            {(t.irisPx / 2).toFixed(0)} px. Crescent width cannot be measured reliably at this resolution. Use
            optical zoom or a telephoto lens, or the native app (higher-resolution stills). See Device
            Calibration docs.
          </p>
        )}
      </div>

      <div className="space-y-4">
        {phase === "prepare" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Preparation and lighting check</CardTitle>
                <CardDescription>
                  Dim light makes the pupils larger, which widens the range the method can measure.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <PrepareChecklist onReady={setPrepOk} />
              <Indicators
                compact
                items={readiness.indicators.filter((i) =>
                  ["face", "light", "pupil", "flash"].includes(i.key),
                )}
              />
              <Button
                className="w-full"
                disabled={status !== "live" || !t.face}
                onClick={() => onPhase("distance")}
              >
                {prepOk ? "Continue to distance" : "Continue (checklist incomplete)"}
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
                  Target {s.targetDistanceM.toFixed(1)} m, estimated from iris size (±4% person-to-person). A
                  tape measure is more accurate.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="num text-center text-5xl font-semibold">
                {t.distanceM === null ? "—" : `${t.distanceM.toFixed(2)} m`}
              </div>
              {t.distanceSdM !== null && (
                <div className="text-muted text-center text-xs">
                  ± {(t.distanceSdM * 100).toFixed(0)} cm (1 SD)
                </div>
              )}
              <Switch
                checked={useManual}
                onChange={setUseManual}
                label="I measured the distance"
                description="Overrides the iris estimate for this session"
              />
              {useManual && (
                <Field label="Measured distance (m)">
                  <Input
                    type="number"
                    step="0.05"
                    min="0.5"
                    max="3"
                    value={manualD ?? ""}
                    onChange={(e) => setManualD(e.target.value ? Number(e.target.value) : null)}
                  />
                </Field>
              )}
              <Indicators
                compact
                items={readiness.indicators.filter((i) => ["distance", "pose", "motion"].includes(i.key))}
              />
              <Button className="w-full" onClick={() => onPhase("capture")} disabled={!t.face}>
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
                  Rotate the phone around the lens to the angle shown, keep it pointed at the eyes, then
                  capture.
                </CardDescription>
              </div>
              <MeridianDial target={step.rotationDeg} measured={measuredRot} size={92} />
            </CardHeader>
            <CardContent className="space-y-4">
              {rotation.permission === "unknown" && (
                <Button size="sm" variant="secondary" className="w-full" onClick={rotation.request}>
                  Enable tilt sensor for angle guidance
                </Button>
              )}
              {rotation.permission !== "granted" && rotation.permission !== "unknown" && (
                <p className="text-muted text-xs">
                  No tilt sensor: the nominal angle {step.rotationDeg}° will be recorded. Rotate carefully.
                </p>
              )}
              <Indicators compact items={readiness.indicators} />
              <Button size="lg" className="w-full" disabled={!readiness.ready || capturing} onClick={capture}>
                {capturing ? <Loader2 className="animate-spin" /> : <Eye />}
                {capturing ? "Capturing…" : `Capture ${s.framesPerMeridian} frames`}
              </Button>
              <StepSummary
                steps={steps}
                frames={frames}
                current={stepIdx}
                minUsable={DEFAULT_GATING.minUsableFramesPerMeridian}
              />
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={stepIdx === 0}
                  onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
                >
                  Previous angle
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={stepIdx >= steps.length - 1}
                  onClick={() => setStepIdx((i) => i + 1)}
                >
                  Next angle
                </Button>
              </div>
              <Button
                className="w-full"
                disabled={!frames.length || capturing}
                variant={allDone ? "primary" : "subtle"}
                onClick={() => {
                  stopCamera();
                  onComplete(frames);
                }}
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
