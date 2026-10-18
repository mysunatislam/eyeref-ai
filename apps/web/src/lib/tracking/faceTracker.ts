"use client";
/**
 * MediaPipe Face Landmarker wrapper (478 landmarks incl. iris, blendshapes, transform matrix).
 * Chosen over a custom detector because it runs on-device in WebAssembly/WebGL at video rate and
 * provides iris landmarks needed for pupil-region localisation and iris-based distance.
 * No identity recognition is performed; landmarks are discarded after each frame except for
 * the derived eye geometry.
 */
import type { FaceLandmarker as FaceLandmarkerT } from "@mediapipe/tasks-vision";
import type { HeadPose } from "../types";
import { eyesFromLandmarks, headPoseFromMatrix, type EyeObservation } from "./eyeGeometry";
import { isFull, toFrame, type TrackView } from "./views";

// Self-hosted by scripts/fetch-models.mjs (runs before every build), so no third-party
// server is contacted at runtime. Override only to serve them from your own CDN.
const WASM_URL = process.env.NEXT_PUBLIC_MEDIAPIPE_WASM_URL || "/mediapipe/wasm";
const MODEL_URL = process.env.NEXT_PUBLIC_FACE_MODEL_URL || "/mediapipe/face_landmarker.task";

export interface FaceObservation {
  eyes: { OD: EyeObservation; OS: EyeObservation };
  headPose: HeadPose;
  blink: { OD: number; OS: number };
  faceBox: { x: number; y: number; w: number; h: number };
  landmarks: { x: number; y: number }[]; // pixel coords, raw frame (for overlay only)
}

let landmarkerPromise: Promise<FaceLandmarkerT> | null = null;

export function loadFaceLandmarker(): Promise<FaceLandmarkerT> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const files = await FilesetResolver.forVisionTasks(WASM_URL);
      const make = (delegate: "GPU" | "CPU") =>
        FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      try {
        return await make("GPU");
      } catch {
        return await make("CPU");
      }
    })().catch((e) => {
      landmarkerPromise = null;
      throw e;
    });
  }
  return landmarkerPromise;
}

/** How much a brightened frame is lifted for the tracker when the face cannot be found in a dim room. */
export const LOW_LIGHT_GAIN = 3;

/**
 * The part of the video frame the tracker should look at (`view`), drawn into `canvas`, and brightened when the
 * view asks for it: in a dim room (which the method needs, so the pupils are wide) a face a metre away is too dark
 * for the tracker. Null when the view is the plain whole frame, which the tracker reads from the video directly.
 * Measurements always read the raw frame.
 */
export function viewFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  view: TrackView,
): HTMLCanvasElement | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h || (!view.bright && isFull(view, w, h))) return null;
  if (canvas.width !== view.w) canvas.width = view.w;
  if (canvas.height !== view.h) canvas.height = view.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (view.bright) ctx.filter = `brightness(${LOW_LIGHT_GAIN}) contrast(1.1)`;
  ctx.drawImage(video, view.x, view.y, view.w, view.h, 0, 0, view.w, view.h);
  ctx.filter = "none";
  return canvas;
}

/**
 * Face landmarks from the video, or from `source` (`view` of the same frame, from `viewFrame`) when given.
 * Landmark coordinates are in the video's pixels either way.
 */
export function observe(
  lm: FaceLandmarkerT,
  video: HTMLVideoElement,
  tsMs: number,
  source?: HTMLCanvasElement | null,
  view?: TrackView | null,
): FaceObservation | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const r = lm.detectForVideo(source ?? video, tsMs);
  const found = r.faceLandmarks?.[0];
  if (!found) return null;
  const face = source && view ? found.map((p) => toFrame(p, view, w, h)) : found;
  const eyes = eyesFromLandmarks(face, w, h, false);
  if (!eyes) return null;
  const m = r.facialTransformationMatrixes?.[0]?.data;
  const headPose = m ? headPoseFromMatrix(m) : { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const cats = r.faceBlendshapes?.[0]?.categories ?? [];
  const score = (n: string) => cats.find((c) => c.categoryName === n)?.score ?? 0;
  // Blendshape names are from the subject's perspective: eyeBlinkRight = subject's right eye = OD.
  const blink = { OD: score("eyeBlinkRight"), OS: score("eyeBlinkLeft") };
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const pts = face.map((p) => {
    const x = p.x * w;
    const y = p.y * h;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
    return { x, y };
  });
  return { eyes, headPose, blink, faceBox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, landmarks: pts };
}
