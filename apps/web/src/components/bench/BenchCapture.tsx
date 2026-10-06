"use client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Flashlight,
  FlashlightOff,
  Loader2,
  RotateCw,
  ScanEye,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EyeCanvas } from "@/components/capture/EyeCanvas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { benchSteps, withStep, type BenchRun, type BenchShot } from "@/lib/bench/run";
import { expectedSearchRadiusPx, useBenchCamera } from "@/lib/bench/useBenchCamera";
import { frameRotationDeg, useScreenAngle } from "@/lib/camera/orientation";
import { isUsable } from "@/lib/cv/quality";
import { formatDiopters } from "@/lib/optics/powerVector";
import { useSettings } from "@/lib/settings";
import type { Circle } from "@/lib/types";
import { plural } from "@/lib/utils";
import { StepGrid, stepState } from "./StepGrid";

const INSET = 240;

function lensInstruction(lensD: number) {
  return lensD === 0
    ? "Take the trial lens out"
    : `Put the ${formatDiopters(lensD)} lens in front of the model eye`;
}

const screenName = (a: number) => (a === 0 || a === 180 ? "portrait" : "landscape");

/** Where a click lands in the video's own pixels, for a video shown with object-fit: contain. */
function videoPoint(e: React.MouseEvent<HTMLElement>, video: HTMLVideoElement) {
  const box = e.currentTarget.getBoundingClientRect();
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const ox = (box.width - video.videoWidth * scale) / 2;
  const oy = (box.height - video.videoHeight * scale) / 2;
  return { x: (e.clientX - box.left - ox) / scale, y: (e.clientY - box.top - oy) / scale };
}

/** The camera side of a real bench run: one step at a time, each a burst like an assessment's. */
export function BenchCapture({
  run,
  onRun,
  onReport,
}: {
  run: BenchRun;
  onRun: (run: BenchRun) => void;
  onReport: () => void;
}) {
  const [s] = useSettings();
  const {
    videoRef,
    status,
    error: cameraError,
    caps,
    start: startCamera,
    setTorch,
    captureStep,
  } = useBenchCamera();
  const screenAngle = useScreenAngle();
  const steps = useMemo(() => benchSteps(run.setup), [run.setup]);
  const [current, setCurrent] = useState(() => {
    const i = steps.findIndex((st) => stepState(run, st) === "todo");
    return i === -1 ? 0 : i;
  });
  const step = steps[current]!;
  const [search, setSearch] = useState<Circle | null>(null);
  const [busy, setBusy] = useState(false);
  const [shots, setShots] = useState<BenchShot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lightOn, setLightOn] = useState(false);
  const overlay = useRef<HTMLCanvasElement>(null);
  const inset = useRef<HTMLCanvasElement>(null);
  const searchRef = useRef<Circle | null>(null);
  useLayoutEffect(() => {
    searchRef.current = search;
  });
  const frameSize = useRef<[number, number] | null>(null);

  const done = steps.every((st) => stepState(run, st) !== "todo");
  const hasLight = run.device.camera !== "rear" || Boolean(caps?.torch);
  const previous = current > 0 ? steps[current - 1] : undefined;
  const turned = previous !== undefined && previous.rotationDeg !== step.rotationDeg;

  // draw the search circle over the preview, and the magnified view around it
  useEffect(() => {
    if (status !== "live") return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      let c = searchRef.current;
      const [w, h] = [video.videoWidth, video.videoHeight];
      const was = frameSize.current;
      if (!c) {
        c = {
          cx: w / 2,
          cy: h / 2,
          r: expectedSearchRadiusPx(w, run.device, s.hfovDeg, run.setup.pupilMm, run.setup.workingDistanceM),
        };
      } else if (was && (was[0] !== w || was[1] !== h)) {
        // the frames turned with the screen: a phone turned about its camera keeps the model eye where it
        // was from the centre
        c = { ...c, cx: w / 2 + (c.cx - was[0] / 2), cy: h / 2 + (c.cy - was[1] / 2) };
      }
      frameSize.current = [w, h];
      if (c !== searchRef.current) {
        searchRef.current = c;
        setSearch(c);
      }
      const ov = overlay.current;
      if (ov) {
        if (ov.width !== video.videoWidth) ov.width = video.videoWidth;
        if (ov.height !== video.videoHeight) ov.height = video.videoHeight;
        const g = ov.getContext("2d");
        if (g) {
          const unit = Math.max(1.5, ov.width / 640);
          g.clearRect(0, 0, ov.width, ov.height);
          g.lineWidth = unit;
          g.strokeStyle = "rgba(74, 163, 255, 0.95)";
          g.beginPath();
          g.arc(c.cx, c.cy, Math.max(c.r, 4 * unit), 0, Math.PI * 2);
          g.stroke();
          g.beginPath();
          g.moveTo(c.cx - c.r * 3, c.cy);
          g.lineTo(c.cx - c.r * 1.4, c.cy);
          g.moveTo(c.cx + c.r * 1.4, c.cy);
          g.lineTo(c.cx + c.r * 3, c.cy);
          g.moveTo(c.cx, c.cy - c.r * 3);
          g.lineTo(c.cx, c.cy - c.r * 1.4);
          g.moveTo(c.cx, c.cy + c.r * 1.4);
          g.lineTo(c.cx, c.cy + c.r * 3);
          g.stroke();
        }
      }
      const iv = inset.current;
      const g2 = iv?.getContext("2d");
      if (iv && g2) {
        const side = Math.max(4 * c.r, 24);
        const k = INSET / side;
        g2.imageSmoothingEnabled = false;
        g2.fillStyle = "#000";
        g2.fillRect(0, 0, INSET, INSET);
        g2.drawImage(video, c.cx - side / 2, c.cy - side / 2, side, side, 0, 0, INSET, INSET);
        g2.lineWidth = 2;
        g2.strokeStyle = "rgba(74, 163, 255, 0.95)";
        g2.beginPath();
        g2.arc(INSET / 2, INSET / 2, c.r * k, 0, Math.PI * 2);
        g2.stroke();
        g2.strokeStyle = "rgba(255, 255, 255, 0.5)";
        g2.setLineDash([3, 3]);
        g2.beginPath();
        g2.arc(INSET / 2, INSET / 2, c.r * k * 0.5, 0, Math.PI * 2);
        g2.stroke();
        g2.setLineDash([]);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [status, videoRef, run.device, run.setup, s.hfovDeg]);

  const move = (dx: number, dy: number) => setSearch((c) => (c ? { ...c, cx: c.cx + dx, cy: c.cy + dy } : c));
  // a quarter of the circle per press
  const nudge = (dx: number, dy: number) => {
    const by = Math.max(1, Math.round((search?.r ?? 4) / 4));
    move(dx * by, dy * by);
  };

  const onPreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video?.videoWidth || !search) return;
    const p = videoPoint(e, video);
    setSearch({ ...search, cx: p.x, cy: p.y });
  };

  const onInsetClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!search) return;
    const box = e.currentTarget.getBoundingClientRect();
    const side = Math.max(4 * search.r, 24);
    move(
      ((e.clientX - box.left) / box.width - 0.5) * side,
      ((e.clientY - box.top) / box.height - 0.5) * side,
    );
  };

  const toggleLight = async () => {
    const want = !lightOn;
    if (await setTorch(want)) setLightOn(want);
  };

  const start = useCallback(() => startCamera("environment"), [startCamera]);

  const capture = async () => {
    if (!search) return;
    setBusy(true);
    setError(null);
    try {
      const taken = await captureStep(run, step, search, {
        frameRotationDeg: screenAngle === null ? null : frameRotationDeg(screenAngle, "environment"),
        lightWasOn: lightOn,
      });
      setShots(taken);
      if (!taken.length) throw new Error("The camera gave no frames. Check that the preview is running.");
      const next = withStep(
        run,
        step,
        taken.map((t) => t.frame),
      );
      onRun(next);
      const usable = taken.filter(
        (t) => t.frame.record.features.pupil && isUsable(t.frame.record.quality),
      ).length;
      if (usable * 2 >= run.setup.framesPerStep) {
        const after = steps.findIndex((st, i) => i > current && stepState(next, st) === "todo");
        const any = steps.findIndex((st) => stepState(next, st) === "todo");
        if (after !== -1 || any !== -1) setCurrent(after !== -1 ? after : any);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usableShots = shots.filter((t) => t.frame.record.features.pupil && isUsable(t.frame.record.quality));
  const pupilPx = search ? search.r : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        <div
          className="border-line relative overflow-hidden rounded-2xl border bg-black"
          data-camera={status}
        >
          <div className="relative aspect-video w-full cursor-crosshair" onClick={onPreviewClick}>
            <video
              ref={videoRef}
              playsInline
              muted
              className="absolute inset-0 h-full w-full object-contain"
            />
            <canvas
              ref={overlay}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              aria-hidden
            />
            {status !== "live" && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
                <div className="max-w-sm space-y-3">
                  <ScanEye className="mx-auto size-10 opacity-80" aria-hidden />
                  <p className="text-sm text-white/80">
                    Point the phone&apos;s rear camera at the model eye. Frames are analysed on this device
                    and the run keeps only the measurements, never an image.
                  </p>
                  {cameraError && <p className="text-sm text-red-300">{cameraError}</p>}
                  <Button onClick={start} disabled={status === "requesting"}>
                    {status === "requesting" ? <Loader2 className="animate-spin" /> : <Camera />}
                    Start camera
                  </Button>
                </div>
              </div>
            )}
            {status === "live" && (
              <div className="pointer-events-none absolute top-2 left-2 flex flex-wrap gap-1.5">
                <Badge className="bg-black/60 text-white">
                  {caps ? `${caps.width}×${caps.height}` : "—"}
                </Badge>
                {screenAngle !== null && (
                  <Badge className="bg-black/60 text-white">
                    screen {screenAngle}° ({screenName(screenAngle)})
                  </Badge>
                )}
                {lightOn && (
                  <Badge className="bg-warn text-white">
                    <Flashlight className="size-3" /> light on
                  </Badge>
                )}
              </div>
            )}
          </div>
        </div>
        {status === "live" && !hasLight && (
          <p
            className="border-bad/40 bg-bad-soft text-ink-2 rounded-xl border px-3 py-2 text-xs"
            role="alert"
          >
            This browser cannot switch the phone&apos;s light on, so there is no light beside the lens and
            nothing to measure. Try another browser on this phone.
          </p>
        )}
        {pupilPx !== null && pupilPx < 8 && (
          <p className="border-warn/40 bg-warn-soft text-ink-2 rounded-xl border px-3 py-2 text-xs">
            At this distance the model eye&apos;s pupil spans about {Math.round(pupilPx)} pixels, too few to
            measure a crescent&apos;s width well. An assessment at this distance has the same limit, so the
            run still shows what this phone can do.
          </p>
        )}
        <StepGrid run={run} steps={steps} current={current} onPick={setCurrent} disabled={busy} />
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>
                Step {current + 1} of {steps.length}
              </CardTitle>
              <CardDescription>
                {plural(run.setup.framesPerStep, "frame")} per step, with the light pulsed as in an
                assessment.
              </CardDescription>
            </div>
            <Badge tone={stepState(run, step) === "todo" ? "neutral" : "accent"}>
              {stepState(run, step) === "todo" ? "to do" : "retake"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {turned && (
              <p className="border-accent/40 bg-accent-soft text-ink rounded-xl border px-3 py-2 text-sm">
                <RotateCw className="mr-1 inline size-4 align-text-bottom" aria-hidden />
                Turn the phone a quarter turn anticlockwise on the mount, as you look at its screen, and let
                the screen turn to landscape. Then centre the circle on the model eye again.
              </p>
            )}
            <p className="text-sm font-semibold" aria-live="polite">
              {lensInstruction(step.lensD)}
              <span className="text-muted font-normal">
                {" "}
                (model eye {formatDiopters(step.refractionD)}), phone at {step.rotationDeg}°.
              </span>
            </p>
            {screenAngle !== null && step.rotationDeg !== 0 && screenAngle === 0 && (
              <p className="text-warn text-xs">
                The screen is still in portrait, so these frames are not turned and test the same geometry as
                0°. Turn off rotation lock to test the turned one.
              </p>
            )}
            <div className="space-y-2">
              <div className="text-ink-2 text-xs font-medium">
                Centre the circle on the model eye&apos;s pupil
              </div>
              <canvas
                ref={inset}
                width={INSET}
                height={INSET}
                onClick={onInsetClick}
                className="border-line block aspect-square w-full cursor-crosshair rounded-xl border bg-black"
                role="img"
                aria-label="Magnified view around the search circle. Click to move the circle there."
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="Move the circle left"
                  onClick={() => nudge(-1, 0)}
                >
                  <ArrowLeft />
                </Button>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="Move the circle up"
                  onClick={() => nudge(0, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="Move the circle down"
                  onClick={() => nudge(0, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="Move the circle right"
                  onClick={() => nudge(1, 0)}
                >
                  <ArrowRight />
                </Button>
                {caps?.torch && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={toggleLight}
                    aria-pressed={lightOn}
                    className="ml-auto"
                  >
                    {lightOn ? <FlashlightOff /> : <Flashlight />} {lightOn ? "Light off" : "Light on to aim"}
                  </Button>
                )}
              </div>
              <label className="text-ink-2 block text-xs">
                Circle size: {search ? Math.round(search.r) : "—"} px
                <input
                  type="range"
                  className="mt-1 block w-full"
                  min={4}
                  max={Math.max(80, Math.round((search?.r ?? 20) * 2))}
                  value={search ? Math.round(search.r) : 20}
                  disabled={!search}
                  onChange={(e) => setSearch((c) => (c ? { ...c, r: Number(e.target.value) } : c))}
                />
              </label>
            </div>
            <Button
              className="w-full"
              size="lg"
              onClick={capture}
              disabled={status !== "live" || !search || busy || !hasLight}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Camera />}
              {busy
                ? "Capturing…"
                : stepState(run, step) === "todo"
                  ? "Capture this step"
                  : "Capture it again"}
            </Button>
            {error && (
              <p className="text-bad text-xs" role="alert">
                {error}
              </p>
            )}
          </CardContent>
        </Card>

        {shots.length > 0 && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Last capture</CardTitle>
                <CardDescription>
                  {usableShots.length} of {shots.length} frames usable.{" "}
                  {usableShots.some((t) => t.frame.record.features.crescentPresent)
                    ? "A crescent is visible."
                    : "No crescent."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2">
              {shots.slice(0, 6).map((t, i) => (
                <EyeCanvas
                  key={i}
                  image={t.image}
                  features={t.frame.record.features}
                  segmentation={t.segmentation}
                  label={t.frame.record.quality.grade}
                />
              ))}
            </CardContent>
          </Card>
        )}

        <Button className="w-full" variant={done ? "primary" : "secondary"} onClick={onReport}>
          {done ? "See the report" : "See the report so far"}
        </Button>
      </div>
    </div>
  );
}
