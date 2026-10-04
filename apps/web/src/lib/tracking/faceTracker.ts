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

const WASM_URL =
  process.env.NEXT_PUBLIC_MEDIAPIPE_WASM_URL ??
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  process.env.NEXT_PUBLIC_FACE_MODEL_URL ??
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

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

export function observe(lm: FaceLandmarkerT, video: HTMLVideoElement, tsMs: number): FaceObservation | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const r = lm.detectForVideo(video, tsMs);
  const face = r.faceLandmarks?.[0];
  if (!face) return null;
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
