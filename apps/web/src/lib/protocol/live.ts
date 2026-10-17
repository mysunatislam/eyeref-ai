"use client";
/**
 * Live camera frame handling: crops each eye from the RAW video frame (never the mirrored
 * preview), converts tracking output into CaptureMetadata, and runs the on-device pipeline.
 */
import { drawEyeOverlay, scaleRgba } from "../cv/draw";
import { imageDataToRgba, laplacianVariance, type RgbaImage } from "../cv/image";
import type { EyeSegmentation } from "../cv/segmentation";
import { processFrame } from "../inference/pipeline";
import type { PhotorefractionEstimator } from "../inference/estimators";
import type { FaceObservation } from "../tracking/faceTracker";
import { distanceFromIris, eyeCropRect, focalPxFromHfov, rollFromEyes } from "../tracking/eyeGeometry";
import type {
  AgeGroup,
  CaptureMetadata,
  Circle,
  DeviceProfile,
  EyeSide,
  FrameRecord,
  Illumination,
} from "../types";

export const MIN_CROP_PX = 96;

export interface LiveContext {
  device: DeviceProfile;
  hfovDeg: number;
  hvidMm: number;
  ageGroup: AgeGroup;
  manualDistanceM: number | null;
  /** the camera's zoom: hfovDeg is the lens's, and zooming narrows it */
  zoom?: number;
}

export interface LiveEyeCrop {
  eye: EyeSide;
  image: RgbaImage;
  iris: Circle; // in crop coordinates (after upsampling)
  rect: { x: number; y: number; size: number };
  upsample: number;
}

export function grabFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx?.drawImage(video, 0, 0, w, h);
  return ctx;
}

export function cropEyes(ctx: CanvasRenderingContext2D, obs: FaceObservation): LiveEyeCrop[] {
  const { width: W, height: H } = ctx.canvas;
  return (["OD", "OS"] as const).map((eye) => {
    const iris = obs.eyes[eye].iris;
    const rect = eyeCropRect(iris, W, H, 1.6);
    const raw = imageDataToRgba(
      ctx.getImageData(rect.x, rect.y, Math.max(rect.size, 1), Math.max(rect.size, 1)),
    );
    const { image, factor } = scaleRgba(raw, MIN_CROP_PX);
    return {
      eye,
      image,
      rect,
      upsample: factor,
      iris: { cx: (iris.cx - rect.x) * factor, cy: (iris.cy - rect.y) * factor, r: iris.r * factor },
    };
  });
}

export function estimateDistance(obs: FaceObservation, frameWidth: number, ctx: LiveContext) {
  const f = focalPxFromHfov(frameWidth, ctx.hfovDeg) * (ctx.zoom ?? 1);
  const d = (obs.eyes.OD.iris.r + obs.eyes.OS.iris.r) / 2;
  return distanceFromIris(2 * d, f, ctx.hvidMm);
}

/** Camera pixels across the iris the live view aims for. Below IRIS_MIN_PX crescents are mismeasured
 * (docs/PHOTOREFRACTION.md, section 7); the target leaves room for the face to move. */
export const IRIS_MIN_PX = 30;
export const IRIS_TARGET_PX = 40;
/** past this, a phone's zoom is mostly digital and the face tracker loses the face as it moves */
export const MAX_AUTO_ZOOM = 3;

/**
 * The zoom to switch to so the iris spans about IRIS_TARGET_PX, or null to stay. It changes only when the iris
 * is under IRIS_MIN_PX, or over 2.5 times the target while zoomed in, and stays within the camera's range and
 * MAX_AUTO_ZOOM. A phone zooms by cropping its sensor before it scales the picture to the stream, so up to the
 * sensor's own resolution the eye gains real pixels.
 */
export function nextZoom(
  irisPx: number,
  zoom: number,
  range: { min: number; max: number; step: number } | null,
): number | null {
  if (!range || !(irisPx > 0)) return null;
  const tooBig = irisPx > 2.5 * IRIS_TARGET_PX && zoom > range.min;
  if (irisPx >= IRIS_MIN_PX && !tooBig) return null;
  const hi = Math.max(range.min, Math.min(range.max, MAX_AUTO_ZOOM));
  let z = Math.min(hi, Math.max(range.min, (zoom * IRIS_TARGET_PX) / irisPx));
  if (range.step > 0) z = range.min + Math.round((z - range.min) / range.step) * range.step;
  z = Math.min(hi, z);
  return Math.abs(z - zoom) < Math.max(range.step, 0.05) ? null : z;
}

export function illuminationFor(device: DeviceProfile, torchOn: boolean): Illumination {
  if (device.camera === "external") return "external_visible";
  if (torchOn) return "torch";
  return "none";
}

export function buildMetadata(args: {
  eye: EyeSide;
  obs: FaceObservation;
  frameWidth: number;
  ctx: LiveContext;
  deviceRotationDeg: number;
  illumination: Illumination;
  frameIndex: number;
  motionPx: number | null;
}): CaptureMetadata {
  const dist = estimateDistance(args.obs, args.frameWidth, args.ctx);
  const manual = args.ctx.manualDistanceM;
  return {
    eye: args.eye,
    timestamp: new Date().toISOString(),
    workingDistanceM: manual ?? dist.distanceM,
    distanceSource: manual ? "manual" : "iris",
    distanceSdM: manual ? 0.03 : dist.sdM,
    deviceRotationDeg: args.deviceRotationDeg,
    headPose: { ...args.obs.headPose, rollDeg: rollFromEyes(args.obs.eyes.OD.iris, args.obs.eyes.OS.iris) },
    illumination: args.illumination,
    sourceAngleImageDeg: null,
    eccentricityMm: null,
    mirrored: false,
    ageGroup: args.ctx.ageGroup,
    frameIndex: args.frameIndex,
    simulated: false,
    motionPxPerFrame: args.motionPx,
    cropUpsample: 1,
  };
}

export interface LiveProcessed {
  eye: EyeSide;
  image: RgbaImage;
  segmentation: EyeSegmentation;
  record: FrameRecord;
  rect: LiveEyeCrop["rect"];
  upsample: number;
}

export function processLive(
  crops: LiveEyeCrop[],
  metaFor: (eye: EyeSide) => CaptureMetadata,
  device: DeviceProfile,
  estimator: PhotorefractionEstimator,
): LiveProcessed[] {
  return crops.map((c) => {
    const { record, segmentation } = processFrame(
      c.image,
      c.iris,
      { ...metaFor(c.eye), cropUpsample: c.upsample },
      device,
      estimator,
    );
    return { eye: c.eye, image: c.image, segmentation, record, rect: c.rect, upsample: c.upsample };
  });
}

/** Mean luma (0..1) inside the face box: a coarse ambient-light indicator for the lighting check. */
export function faceLuma(ctx: CanvasRenderingContext2D, obs: FaceObservation): number {
  const { x, y, w, h } = obs.faceBox;
  const sx = Math.max(0, Math.round(x + w * 0.2));
  const sy = Math.max(0, Math.round(y + h * 0.2));
  const sw = Math.max(1, Math.round(w * 0.6));
  const sh = Math.max(1, Math.round(h * 0.6));
  const d = ctx.getImageData(sx, sy, sw, sh).data;
  let s = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {
    s += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    n++;
  }
  return n ? s / n / 255 : 0;
}

export function focusScore(img: RgbaImage): number {
  return laplacianVariance(img);
}

/** Draw the live overlay: landmarks, eye boxes, iris/pupil circles, glint, gaze and source meridian. */
export function drawLiveOverlay(
  ctx: CanvasRenderingContext2D,
  obs: FaceObservation | null,
  processed: LiveProcessed[] | null,
  opts: { landmarks: boolean; ok: boolean },
) {
  const { width: W, height: H } = ctx.canvas;
  ctx.clearRect(0, 0, W, H);
  if (!obs) return;
  const unit = Math.max(1.5, W / 640);
  if (opts.landmarks) {
    ctx.fillStyle = "rgba(160, 200, 255, 0.55)";
    for (let i = 0; i < obs.landmarks.length; i += 3) {
      const p = obs.landmarks[i]!;
      ctx.fillRect(p.x - unit / 2, p.y - unit / 2, unit, unit);
    }
  }
  ctx.lineWidth = unit;
  ctx.strokeStyle = opts.ok ? "rgba(60, 207, 145, 0.9)" : "rgba(240, 173, 60, 0.9)";
  const fb = obs.faceBox;
  ctx.strokeRect(fb.x, fb.y, fb.w, fb.h);
  for (const eye of ["OD", "OS"] as const) {
    const e = obs.eyes[eye];
    const box = eyeCropRect(e.iris, W, H, 1.6);
    ctx.strokeStyle = "rgba(74, 163, 255, 0.95)";
    ctx.strokeRect(box.x, box.y, box.size, box.size);
    ctx.beginPath();
    ctx.arc(e.iris.cx, e.iris.cy, e.iris.r, 0, Math.PI * 2);
    ctx.stroke();
    // gaze proxy: iris offset from the eye-corner midpoint
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.moveTo(e.iris.cx, e.iris.cy);
    ctx.lineTo(e.iris.cx + e.gazeOffset.x * box.size * 3, e.iris.cy + e.gazeOffset.y * box.size * 3);
    ctx.stroke();
    ctx.font = `${Math.round(11 * unit)}px ui-sans-serif, system-ui`;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(eye, box.x, box.y - 4 * unit);
    const p = processed?.find((q) => q.eye === eye);
    if (p) {
      ctx.save();
      ctx.translate(p.rect.x, p.rect.y);
      ctx.scale(1 / p.upsample, 1 / p.upsample);
      drawEyeOverlay(ctx, p.record.features, p.segmentation, { iris: false, scale: 1 });
      ctx.restore();
    }
  }
}
