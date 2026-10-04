// Downloads MediaPipe WASM + face landmarker model into public/mediapipe so no
// third-party CDN is contacted at runtime (privacy / offline clinics).
import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dest = `${root}public/mediapipe`;
await mkdir(`${dest}/wasm`, { recursive: true });
await cp(`${root}node_modules/@mediapipe/tasks-vision/wasm`, `${dest}/wasm`, { recursive: true });
const url =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const res = await fetch(url);
if (!res.ok) throw new Error(`model download failed: ${res.status}`);
await writeFile(`${dest}/face_landmarker.task`, Buffer.from(await res.arrayBuffer()));
console.log("Self-hosted MediaPipe assets in public/mediapipe. Set in .env.local:");
console.log("NEXT_PUBLIC_MEDIAPIPE_WASM_URL=/mediapipe/wasm");
console.log("NEXT_PUBLIC_FACE_MODEL_URL=/mediapipe/face_landmarker.task");
