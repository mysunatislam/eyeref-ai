// Self-hosts the MediaPipe runtime and face landmarker model under public/mediapipe, so the
// app contacts no third-party server at runtime (privacy, offline clinics, strict CSP).
// Runs automatically before `npm run build`. The model download is pinned by SHA-256.
//   EYEREF_SKIP_MODEL_FETCH=1  skip (then set NEXT_PUBLIC_MEDIAPIPE_WASM_URL / NEXT_PUBLIC_FACE_MODEL_URL)
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";

if (process.env.EYEREF_SKIP_MODEL_FETCH === "1") {
  console.warn("[fetch-models] skipped; the app will load MediaPipe from NEXT_PUBLIC_* URLs");
  process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const dest = `${root}public/mediapipe`;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

await mkdir(`${dest}/wasm`, { recursive: true });
const src = `${root}node_modules/@mediapipe/tasks-vision/wasm`;
for (const f of await readdir(src)) await copyFile(`${src}/${f}`, `${dest}/wasm/${f}`);

const model = `${dest}/face_landmarker.task`;
if (existsSync(model) && sha256(await readFile(model)) === MODEL_SHA256) {
  console.log("[fetch-models] MediaPipe runtime copied; model already present and verified");
  process.exit(0);
}
const res = await fetch(MODEL_URL);
if (!res.ok) throw new Error(`[fetch-models] model download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = sha256(buf);
if (got !== MODEL_SHA256) {
  throw new Error(`[fetch-models] model checksum mismatch: expected ${MODEL_SHA256}, got ${got}`);
}
await writeFile(`${model}.part`, buf);
await rename(`${model}.part`, model);
console.log(
  `[fetch-models] MediaPipe runtime and verified model (${(buf.length / 1e6).toFixed(1)} MB) in public/mediapipe`,
);
