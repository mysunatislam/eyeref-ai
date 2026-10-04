/**
 * Browser-only drawing helpers for eye crops and analysis overlays.
 * Overlays are drawn from the SAME feature/segmentation objects the estimator used, so what the
 * research dashboard shows is exactly what was measured.
 */
import type { Circle, PhotorefractionFeatures } from "../types";
import type { EyeSegmentation } from "./segmentation";
import { createImage, imageDataToRgba, lumaMap, type RgbaImage } from "./image";

export function rgbaToImageData(img: RgbaImage): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

export function drawRgba(canvas: HTMLCanvasElement, img: RgbaImage) {
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d")?.putImageData(rgbaToImageData(img), 0, 0);
}

export function rgbaToDataUrl(img: RgbaImage): string {
  const c = document.createElement("canvas");
  drawRgba(c, img);
  return c.toDataURL("image/png");
}

export async function dataUrlToRgba(url: string): Promise<RgbaImage> {
  const im = new Image();
  im.src = url;
  await im.decode();
  const c = document.createElement("canvas");
  c.width = im.naturalWidth;
  c.height = im.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(im, 0, 0);
  return imageDataToRgba(ctx.getImageData(0, 0, c.width, c.height));
}

/** Perceptual-ish colormap (dark blue -> cyan -> yellow -> red) for reflex-intensity heatmaps. */
export function heatmap(img: RgbaImage): RgbaImage {
  const L = lumaMap(img);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of L) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const out = createImage(img.width, img.height);
  const stops: [number, [number, number, number]][] = [
    [0, [12, 18, 60]],
    [0.35, [20, 120, 190]],
    [0.6, [60, 200, 170]],
    [0.8, [245, 210, 60]],
    [1, [230, 50, 40]],
  ];
  for (let i = 0; i < L.length; i++) {
    const t = (L[i]! - lo) / Math.max(hi - lo, 1e-6);
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const [t0, c0] = stops[k]!;
    const [t1, c1] = stops[k + 1]!;
    const u = Math.min(1, Math.max(0, (t - t0) / Math.max(t1 - t0, 1e-6)));
    out.data[4 * i] = c0[0] + (c1[0] - c0[0]) * u;
    out.data[4 * i + 1] = c0[1] + (c1[1] - c0[1]) * u;
    out.data[4 * i + 2] = c0[2] + (c1[2] - c0[2]) * u;
    out.data[4 * i + 3] = 255;
  }
  return out;
}

export interface OverlayOptions {
  iris?: boolean;
  pupil?: boolean;
  glint?: boolean;
  crescent?: boolean;
  source?: boolean;
  scale?: number;
}

const circle = (ctx: CanvasRenderingContext2D, c: Circle, s: number) => {
  ctx.beginPath();
  ctx.arc(c.cx * s, c.cy * s, c.r * s, 0, Math.PI * 2);
  ctx.stroke();
};

/** Draw analysis overlays for one eye crop into a 2D context (coordinates in crop pixels * scale). */
export function drawEyeOverlay(
  ctx: CanvasRenderingContext2D,
  f: PhotorefractionFeatures,
  seg: EyeSegmentation | null,
  o: OverlayOptions = {},
) {
  const s = o.scale ?? 1;
  const lw = Math.max(1, s * 0.8);
  ctx.save();
  ctx.lineWidth = lw;
  if (o.crescent !== false && seg && f.crescentPresent) {
    ctx.fillStyle = "rgba(255, 214, 10, 0.38)";
    for (let y = 0; y < seg.height; y++)
      for (let x = 0; x < seg.width; x++)
        if (seg.crescentMask[y * seg.width + x]) ctx.fillRect(x * s, y * s, s, s);
  }
  if (o.iris !== false && f.iris) {
    ctx.strokeStyle = "rgba(74, 163, 255, 0.95)";
    ctx.setLineDash([4 * lw, 3 * lw]);
    circle(ctx, f.iris, s);
    ctx.setLineDash([]);
  }
  if (o.pupil !== false && f.pupil) {
    ctx.strokeStyle = "rgba(54, 208, 224, 1)";
    circle(ctx, f.pupil, s);
  }
  if (o.glint !== false && f.glint) {
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    const [gx, gy] = f.glint;
    ctx.beginPath();
    ctx.moveTo((gx - 3) * s, gy * s);
    ctx.lineTo((gx + 3) * s, gy * s);
    ctx.moveTo(gx * s, (gy - 3) * s);
    ctx.lineTo(gx * s, (gy + 3) * s);
    ctx.stroke();
  }
  if (o.source !== false && f.pupil && f.sourceAngleImageDeg !== null) {
    // Arrow from the pupil centre towards the light source (image angle, y up).
    const a = (f.sourceAngleImageDeg * Math.PI) / 180;
    const { cx, cy, r } = f.pupil;
    const x1 = cx + Math.cos(a) * r * 1.9;
    const y1 = cy - Math.sin(a) * r * 1.9;
    ctx.strokeStyle = "rgba(255, 170, 0, 0.95)";
    ctx.beginPath();
    ctx.moveTo((cx - Math.cos(a) * r * 1.9) * s, (cy + Math.sin(a) * r * 1.9) * s);
    ctx.lineTo(x1 * s, y1 * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x1 * s, y1 * s, 2.5 * lw, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 170, 0, 0.95)";
    ctx.fill();
  }
  ctx.restore();
}

/** Upsample small live crops so morphology has room to work (adds no information - noted in docs). */
export function scaleRgba(img: RgbaImage, minSize: number): { image: RgbaImage; factor: number } {
  if (img.width >= minSize || typeof document === "undefined") return { image: img, factor: 1 };
  const factor = minSize / img.width;
  const src = document.createElement("canvas");
  drawRgba(src, img);
  const dst = document.createElement("canvas");
  dst.width = Math.round(img.width * factor);
  dst.height = Math.round(img.height * factor);
  const ctx = dst.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
  return { image: imageDataToRgba(ctx.getImageData(0, 0, dst.width, dst.height)), factor };
}
