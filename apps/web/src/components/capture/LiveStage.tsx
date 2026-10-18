"use client";
import { Camera, Eye, Flashlight, Loader2, RefreshCw, ScanFace } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { probedRotationDeg, turnToTarget, useScreenAngle } from "@/lib/camera/orientation";
import { rgbaToDataUrl } from "@/lib/cv/draw";
import { isUsable } from "@/lib/cv/quality";
import { DEFAULT_GATING } from "@/lib/inference/fusion";
import { IRIS_MIN_PX, nextZoom } from "@/lib/protocol/live";
import { activeDevice, buildProtocol, COUNTDOWN_S, estimatorFor } from "@/lib/protocol/protocol";
import { beep, TONES, unlockAudio } from "@/lib/protocol/beep";
import {
  burstSummary,
  distanceAdvice,
  evaluateReadiness,
  flashMissing,
  rotationError,
  type BurstSummary,
} from "@/lib/protocol/readiness";
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

/** how long everything must stay ready before a hands-free capture, and the pause after one */
const AUTO_HOLD_MS = 1500;
const AUTO_PAUSE_MS = 4000;

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
  const screenAngle = useScreenAngle();
  const step = steps[Math.min(stepIdx, steps.length - 1)]!;
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
    frameRotationDeg,
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
    zoom,
    setZoom,
    testTorch,
    confirmTorch,
  } = useLiveTracker(ctx, estimator, screenAngle);
  const [torchTest, setTorchTest] = useState<"idle" | "asked" | "failed">("idle");
  // the phone's turn from the head, read from the picture: the frame's rotation and the eyes' tilt in it
  const measuredRot = t.face && t.rollDeg !== null ? probedRotationDeg(frameRotationDeg, t.rollDeg) : null;
  const rotationOff =
    phase === "capture" && measuredRot !== null ? rotationError(measuredRot, step.rotationDeg) : null;
  const [frames, setFrames] = useState<FrameRecord[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [prepOk, setPrepOk] = useState(false);
  const [auto, setAuto] = useState(false);
  const [lastBurst, setLastBurst] = useState<BurstSummary | null>(null);
  const readySince = useRef<number | null>(null);
  const lastAuto = useRef(0);
  const frameCounter = useRef(0);
  // zoom in until the iris has enough camera pixels, between bursts and at most every 1.5 s, so each change
  // shows in the picture before the next is judged
  const zoomTo = t.irisPx !== null ? nextZoom(t.irisPx, zoom, caps?.zoom ?? null) : null;
  const lastZoom = useRef(0);
  useEffect(() => {
    if (zoomTo === null || capturing || status !== "live" || Date.now() - lastZoom.current < 1500) return;
    lastZoom.current = Date.now();
    void setZoom(zoomTo);
  }, [zoomTo, capturing, status, setZoom]);

  // a face lost while zoomed in may be outside the cropped view: zoom back out after a few seconds
  const faceSeen = useRef(0);
  useEffect(() => {
    if (t.face) {
      faceSeen.current = Date.now();
      return;
    }
    const zmin = caps?.zoom?.min ?? 1;
    if (status !== "live" || capturing || zoom <= zmin + 0.01) return;
    const id = setTimeout(() => {
      if (Date.now() - faceSeen.current >= 3000) void setZoom(zmin);
    }, 3000);
    return () => clearTimeout(id);
  }, [t.face, zoom, caps, status, capturing, setZoom]);

  const startCamera = useCallback(async () => {
    await ensureLandmarker();
    await start(device.camera === "rear" ? "environment" : "user");
  }, [ensureLandmarker, start, device.camera]);

  const flashHint = flashMissing({
    hasSource: device.flashOffsetMm !== null,
    facing,
    torch: Boolean(caps?.torch),
    deviceCamera: device.camera,
  });
  const flashAvailable = flashHint === null;
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
    flashMissingHint: flashHint ?? undefined,
    deviceRotationErrorDeg: rotationOff,
    deviceTurn: rotationOff === null ? null : turnToTarget(rotationOff, facing),
  });

  const capture = async () => {
    setCapturing(true);
    for (let c = COUNTDOWN_S; c > 0; c--) {
      setCount(c);
      beep(TONES.tick);
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
      const passed = good("OD") && good("OS");
      setLastBurst(burstSummary(recs, s.framesPerMeridian));
      if (passed) {
        beep(TONES.good);
        setTimeout(() => beep(TONES.good), 180);
      } else beep(TONES.retake, 400);
      if (passed && stepIdx < steps.length - 1) setStepIdx((i) => i + 1);
    } finally {
      setCapturing(false);
      lastAuto.current = Date.now();
    }
  };

  const allDone = steps.every((st) => frames.some((f) => f.protocolRotationDeg === st.rotationDeg));
  // hands-free: capture once everything has been ready for a moment, for someone with no helper to tap
  const stepGood = (["OD", "OS"] as const).every(
    (eye) =>
      frames.filter(
        (f) => f.protocolRotationDeg === step.rotationDeg && f.metadata.eye === eye && isUsable(f.quality),
      ).length >= DEFAULT_GATING.minUsableFramesPerMeridian,
  );
  useEffect(() => {
    if (!auto || phase !== "capture" || capturing || !readiness.ready) {
      readySince.current = null;
      return;
    }
    if (stepGood) return;
    readySince.current ??= Date.now();
    const id = setTimeout(
      () => {
        if (readySince.current !== null && Date.now() - lastAuto.current > AUTO_PAUSE_MS) void capture();
      },
      Math.max(0, AUTO_HOLD_MS - (Date.now() - readySince.current)),
    );
    return () => clearTimeout(id);
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <div
          className="border-line relative overflow-hidden rounded-2xl border bg-black"
          data-camera={status}
          data-landmarker={lmStatus}
          data-face={t.face ? "found" : "lost"}
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
                  <Badge
                    className={t.irisPx < IRIS_MIN_PX ? "bg-bad/80 text-white" : "bg-black/60 text-white"}
                  >
                    iris {t.irisPx.toFixed(0)} px
                  </Badge>
                )}
                {zoom > 1.01 && <Badge className="bg-black/60 text-white">{zoom.toFixed(1)}× zoom</Badge>}
                {t.lowLight && t.face && (
                  <Badge className="bg-black/60 text-white">dim: face found on a brightened view</Badge>
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
        {status === "live" && device.camera === "rear" && facing === "environment" && !caps?.torch && (
          <div
            className="border-warn/40 bg-warn-soft text-ink-2 space-y-2 rounded-xl border px-3 py-2 text-xs"
            data-testid="torch-test"
          >
            <p>
              The browser did not say it can switch on the flash. Some phones (iPhone Safari) can, without
              saying so: test it.
            </p>
            {torchTest === "asked" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ink font-medium">Did the flash light up?</span>
                <Button size="sm" onClick={() => (confirmTorch(), setTorchTest("idle"))}>
                  Yes
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setTorchTest("failed")}>
                  No
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => setTorchTest((await testTorch()) ? "asked" : "failed")}
              >
                <Flashlight /> Test flash
              </Button>
            )}
            {torchTest === "failed" && (
              <p>
                This browser cannot switch on the flash, so the eyes cannot be measured here. On iPhone,
                update iOS and use Safari; otherwise use Chrome on an Android phone.
              </p>
            )}
          </div>
        )}
        {t.irisPx !== null && t.irisPx < IRIS_MIN_PX && zoomTo === null && (
          <p className="border-warn/40 bg-warn-soft text-ink-2 rounded-xl border px-3 py-2 text-xs">
            The iris spans only {t.irisPx.toFixed(0)} pixels, so the pupil is under{" "}
            {(t.irisPx / 2).toFixed(0)} px, and{" "}
            {caps?.zoom ? "the camera cannot zoom further" : "this camera cannot zoom"}. Crescent width cannot
            be measured reliably below {IRIS_MIN_PX} px across the iris. Use a phone with optical zoom or 4K
            video.
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
                  Target {s.targetDistanceM.toFixed(1)} m between the phone and the eyes, read from the size
                  of the iris (±4% person-to-person). A tape measure is more accurate.
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
              {t.distanceM !== null && (
                <p
                  className="text-center text-lg font-semibold"
                  data-testid="distance-advice"
                  aria-live="polite"
                >
                  {distanceAdvice(t.distanceM, s.targetDistanceM) ?? "Good distance: hold here"}
                </p>
              )}
              <p className="text-ink-2 text-xs">
                {s.targetDistanceM.toFixed(1)} m is farther than you can hold a phone from your own face (an
                outstretched arm is about 0.6 m). Stand the phone at eye height on a shelf or a stack of
                books, or ask someone to hold it, then move until this says to hold. A{" "}
                {s.targetDistanceM.toFixed(1)} m string or tape from the phone to your cheekbone checks it.
              </p>
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
                  Turn the phone around its lens until the two lines on the dial meet, keep it pointed at the
                  eyes, then capture. The person looks at the flash and holds still through the countdown; the
                  flash blinks once.
                </CardDescription>
              </div>
              <MeridianDial target={step.rotationDeg} measured={measuredRot} facing={facing} size={92} />
            </CardHeader>
            <CardContent className="space-y-4">
              {measuredRot === null && (
                <p className="text-muted text-xs">
                  The angle is read from the tilt of the eyes in the picture, so it shows once both eyes are
                  tracked.
                  {!t.face &&
                    step.rotationDeg !== 0 &&
                    " If the face is lost as the phone turns, turn it back upright, then slowly round again so the tracker can follow the face."}
                </p>
              )}
              <Indicators compact items={readiness.indicators} />
              <Switch
                checked={auto}
                onChange={(on) => {
                  if (on) unlockAudio();
                  setAuto(on);
                }}
                label="Capture by itself"
                description="For measuring yourself: it captures once everything is green, beeps through the countdown, then two high beeps for a good capture or one low beep for a retake."
              />
              {lastBurst && (
                <p
                  className={
                    lastBurst.usable >= lastBurst.needed
                      ? "text-ok text-xs"
                      : "border-warn/40 bg-warn-soft text-ink-2 rounded-xl border px-3 py-2 text-xs"
                  }
                  data-testid="last-burst"
                >
                  Last capture: {lastBurst.usable} of {lastBurst.total} eye images usable.
                  {lastBurst.reasons.length > 0 && <> Rejected for: {lastBurst.reasons.join("; ")}.</>}
                  {lastBurst.fix && <strong className="mt-1 block">{lastBurst.fix}</strong>}
                </p>
              )}
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
