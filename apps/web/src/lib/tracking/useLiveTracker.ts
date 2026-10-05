"use client";
/**
 * Live tracking loop: camera + MediaPipe landmarks + throttled on-device eye analysis.
 * Produces UI telemetry for the guidance indicators and performs synchronized burst captures
 * with a short torch pulse (so the pupil has no time to constrict).
 */
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCamera } from "../camera/useCamera";
import { isUsable } from "../cv/quality";
import type { PhotorefractionEstimator } from "../inference/estimators";
import {
  buildMetadata,
  cropEyes,
  drawLiveOverlay,
  estimateDistance,
  faceLuma,
  grabFrame,
  illuminationFor,
  processLive,
  type LiveContext,
  type LiveProcessed,
} from "../protocol/live";
import { FRAME_INTERVAL_MS, TORCH_SETTLE_MS } from "../protocol/protocol";
import type { EyeSide, QualityGrade } from "../types";
import { loadFaceLandmarker, observe, type FaceObservation } from "./faceTracker";

export interface Telemetry {
  face: boolean;
  distanceM: number | null;
  distanceSdM: number | null;
  luma: number | null;
  yawDeg: number | null;
  pitchDeg: number | null;
  rollDeg: number | null;
  gaze: number | null;
  blink: number | null;
  motionPx: number | null;
  pupilMm: Record<EyeSide, number | null>;
  grade: Record<EyeSide, QualityGrade | null>;
  crescent: Record<EyeSide, boolean>;
  irisPx: number | null;
  fps: number;
}

const EMPTY: Telemetry = {
  face: false,
  distanceM: null,
  distanceSdM: null,
  luma: null,
  yawDeg: null,
  pitchDeg: null,
  rollDeg: null,
  gaze: null,
  blink: null,
  motionPx: null,
  pupilMm: { OD: null, OS: null },
  grade: { OD: null, OS: null },
  crescent: { OD: false, OS: false },
  irisPx: null,
  fps: 0,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useLiveTracker(
  ctx: LiveContext,
  estimator: PhotorefractionEstimator,
  deviceRotationDeg: number,
) {
  const cam = useCamera();
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const frameCanvas = useRef<HTMLCanvasElement | null>(null);
  const lmRef = useRef<FaceLandmarker | null>(null);
  const [lmStatus, setLmStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [lmError, setLmError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry>(EMPTY);
  const [showLandmarks, setShowLandmarks] = useState(true);
  const busy = useRef(false);
  const lastTs = useRef(0);
  const lastIris = useRef<{ x: number; y: number } | null>(null);
  const latest = useRef<{ obs: FaceObservation | null; processed: LiveProcessed[] | null }>({
    obs: null,
    processed: null,
  });
  const live = useRef({ ctx, estimator, deviceRotationDeg, torchOn: cam.torchOn, showLandmarks });
  useLayoutEffect(() => {
    live.current = { ctx, estimator, deviceRotationDeg, torchOn: cam.torchOn, showLandmarks };
  });

  const nextTs = () => {
    const t = Math.max(performance.now(), lastTs.current + 1);
    lastTs.current = t;
    return t;
  };

  const ensureLandmarker = useCallback(async () => {
    if (lmRef.current) return;
    setLmStatus("loading");
    try {
      lmRef.current = await loadFaceLandmarker();
      setLmStatus("ready");
    } catch (e) {
      setLmStatus("error");
      setLmError(
        `Face tracker failed to load (${(e as Error).message}). The model files are served from /mediapipe; rebuild the app if they are missing.`,
      );
    }
  }, []);

  useEffect(() => {
    if (cam.status !== "live") return;
    let raf = 0;
    let lastAnalysis = 0;
    let lastPublish = 0;
    let lastLuma = 0;
    let luma: number | null = null;
    let frames = 0;
    let fpsT0 = performance.now();
    let fps = 0;
    if (!frameCanvas.current) frameCanvas.current = document.createElement("canvas");
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const video = cam.videoRef.current;
      const lm = lmRef.current;
      if (!video || !lm || busy.current || video.readyState < 2) return;
      const now = performance.now();
      const obs = observe(lm, video, nextTs());
      frames++;
      if (now - fpsT0 > 1000) {
        fps = (frames * 1000) / (now - fpsT0);
        frames = 0;
        fpsT0 = now;
      }
      const { ctx: lctx, estimator: est, deviceRotationDeg: rot, torchOn } = live.current;
      let motion: number | null = null;
      if (obs) {
        const c = {
          x: (obs.eyes.OD.iris.cx + obs.eyes.OS.iris.cx) / 2,
          y: (obs.eyes.OD.iris.cy + obs.eyes.OS.iris.cy) / 2,
        };
        if (lastIris.current) motion = Math.hypot(c.x - lastIris.current.x, c.y - lastIris.current.y);
        lastIris.current = c;
      } else lastIris.current = null;
      let processed = latest.current.processed;
      if (obs && now - lastAnalysis > 250) {
        lastAnalysis = now;
        const g = grabFrame(video, frameCanvas.current!);
        if (g) {
          const crops = cropEyes(g, obs);
          const ill = illuminationFor(lctx.device, torchOn);
          processed = processLive(
            crops,
            (eye) =>
              buildMetadata({
                eye,
                obs,
                frameWidth: video.videoWidth,
                ctx: lctx,
                deviceRotationDeg: rot,
                illumination: ill,
                frameIndex: -1,
                motionPx: motion,
              }),
            lctx.device,
            est,
          );
          if (now - lastLuma > 500) {
            luma = faceLuma(g, obs);
            lastLuma = now;
          }
        }
      }
      if (!obs) processed = null;
      latest.current = { obs, processed };
      const ov = overlayRef.current;
      if (ov) {
        if (ov.width !== video.videoWidth) ov.width = video.videoWidth;
        if (ov.height !== video.videoHeight) ov.height = video.videoHeight;
        const c2 = ov.getContext("2d");
        if (c2)
          drawLiveOverlay(c2, obs, processed, {
            landmarks: live.current.showLandmarks,
            ok: Boolean(processed?.every((p) => isUsable(p.record.quality))),
          });
      }
      if (now - lastPublish > 120) {
        lastPublish = now;
        if (!obs) {
          setTelemetry({ ...EMPTY, luma, fps });
          return;
        }
        const d = estimateDistance(obs, video.videoWidth, lctx);
        const pick = <T>(f: (p: LiveProcessed) => T, fallback: T) => ({
          OD: processed?.find((p) => p.eye === "OD") ? f(processed.find((p) => p.eye === "OD")!) : fallback,
          OS: processed?.find((p) => p.eye === "OS") ? f(processed.find((p) => p.eye === "OS")!) : fallback,
        });
        const rollDeg = buildMetadata({
          eye: "OD",
          obs,
          frameWidth: video.videoWidth,
          ctx: lctx,
          deviceRotationDeg: rot,
          illumination: "none",
          frameIndex: -1,
          motionPx: null,
        }).headPose.rollDeg;
        setTelemetry({
          face: true,
          distanceM: lctx.manualDistanceM ?? d.distanceM,
          distanceSdM: lctx.manualDistanceM ? 0.03 : d.sdM,
          luma,
          yawDeg: obs.headPose.yawDeg,
          pitchDeg: obs.headPose.pitchDeg,
          rollDeg,
          gaze: Math.max(
            Math.hypot(obs.eyes.OD.gazeOffset.x, obs.eyes.OD.gazeOffset.y),
            Math.hypot(obs.eyes.OS.gazeOffset.x, obs.eyes.OS.gazeOffset.y),
          ),
          blink: Math.max(obs.blink.OD, obs.blink.OS),
          motionPx: motion,
          pupilMm: pick((p) => p.record.features.pupilDiameterMm, null),
          grade: pick((p) => p.record.quality.grade, null),
          crescent: pick((p) => p.record.features.crescentPresent, false),
          irisPx: obs.eyes.OD.iris.r * 2,
          fps,
        });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cam.status, cam.videoRef]);

  /** Burst capture: torch pulse -> n synchronized binocular frames -> torch off. */
  const captureBurst = useCallback(
    async (n: number, frameIndexStart: number, onFrame?: (i: number, p: LiveProcessed[]) => void) => {
      const video = cam.videoRef.current;
      const lm = lmRef.current;
      if (!video || !lm) throw new Error("Camera or tracker not ready");
      const { ctx: lctx, estimator: est, deviceRotationDeg: rot } = live.current;
      busy.current = true;
      const out: LiveProcessed[][] = [];
      let torch = false;
      try {
        if (lctx.device.camera === "rear" && cam.caps?.torch) {
          torch = await cam.setTorch(true);
          await sleep(TORCH_SETTLE_MS);
        }
        let prev: { x: number; y: number } | null = null;
        for (let i = 0; i < n; i++) {
          const obs = observe(lm, video, nextTs());
          const g = grabFrame(
            video,
            frameCanvas.current ?? (frameCanvas.current = document.createElement("canvas")),
          );
          if (obs && g) {
            const c = {
              x: (obs.eyes.OD.iris.cx + obs.eyes.OS.iris.cx) / 2,
              y: (obs.eyes.OD.iris.cy + obs.eyes.OS.iris.cy) / 2,
            };
            const motion = prev ? Math.hypot(c.x - prev.x, c.y - prev.y) : null;
            prev = c;
            const ill = illuminationFor(lctx.device, torch);
            const p = processLive(
              cropEyes(g, obs),
              (eye) =>
                buildMetadata({
                  eye,
                  obs,
                  frameWidth: video.videoWidth,
                  ctx: lctx,
                  deviceRotationDeg: rot,
                  illumination: ill,
                  frameIndex: frameIndexStart + i,
                  motionPx: motion,
                }),
              lctx.device,
              est,
            );
            out.push(p);
            onFrame?.(i, p);
          }
          await sleep(FRAME_INTERVAL_MS);
        }
      } finally {
        if (torch) await cam.setTorch(false);
        busy.current = false;
      }
      return out;
    },
    [cam],
  );

  return {
    videoRef: cam.videoRef,
    overlayRef,
    status: cam.status,
    error: cam.error,
    facing: cam.facing,
    caps: cam.caps,
    torchOn: cam.torchOn,
    startCamera: cam.start,
    stopCamera: cam.stop,
    lmStatus,
    lmError,
    ensureLandmarker,
    telemetry,
    captureBurst,
    showLandmarks,
    setShowLandmarks,
  };
}
