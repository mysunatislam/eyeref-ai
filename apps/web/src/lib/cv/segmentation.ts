/**
 * Classical eye segmentation - same algorithm as backend/eyeref/cv/segmentation.py.
 * The iris circle comes from the face-landmark model (MediaPipe iris points) or the simulator.
 */
import type { Circle } from "../types";
import {
  connectedComponents,
  dilate3,
  erode3,
  fillHoles,
  fitCircle,
  lumaMap,
  otsu,
  redChromaMap,
  redMap,
  saturationMap,
  type RgbaImage,
} from "./image";

export interface EyeSegmentation {
  iris: Circle;
  pupil: Circle | null;
  pupilMask: Uint8Array;
  glint: [number, number] | null;
  glintMask: Uint8Array;
  crescentMask: Uint8Array;
  crescentEta: number;
  crescentContrast: number;
  pupilCoverage: number;
  width: number;
  height: number;
}

function detectGlint(
  img: RgbaImage,
  region: Uint8Array,
): { glint: [number, number] | null; mask: Uint8Array } {
  const { width: w, height: h } = img;
  const L = lumaMap(img);
  const S = saturationMap(img);
  const cand = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++)
    if (region[i] && L[i]! > 0.82 && S[i]! < 0.35) {
      cand[i] = 1;
      any = true;
    }
  if (!any) return { glint: null, mask: new Uint8Array(w * h) };
  const { labels, stats } = connectedComponents(cand, w, h);
  let best = 1;
  for (let k = 2; k < stats.length; k++) if (stats[k]!.area > stats[best]!.area) best = k;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (labels[i] === best) m[i] = 1;
  const st = stats[best]!;
  return { glint: [st.sx / st.area, st.sy / st.area], mask: dilate3(m, w, h, 2) };
}

export function segmentEye(img: RgbaImage, iris: Circle, flash = true): EyeSegmentation {
  const { width: w, height: h } = img;
  const n = w * h;
  const region = new Uint8Array(n);
  const r85 = (0.85 * iris.r) ** 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if ((x - iris.cx) ** 2 + (y - iris.cy) ** 2 <= r85) region[y * w + x] = 1;
  const { glint, mask: glintMask } = detectGlint(img, region);
  const L = lumaMap(img);
  const chroma = redChromaMap(img);
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++)
    score[i] = flash ? chroma[i]! * Math.min(1, Math.max(0, L[i]! / 0.12)) : 1 - L[i]!;
  const vals: number[] = [];
  for (let i = 0; i < n; i++) if (region[i] && !glintMask[i]) vals.push(score[i]!);
  const { threshold } = otsu(vals);
  let cand: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (region[i] && (score[i]! > threshold || glintMask[i])) cand[i] = 1;
  cand = dilate3(erode3(cand, w, h), w, h); // morphological opening
  const empty = (): EyeSegmentation => ({
    iris,
    pupil: null,
    pupilMask: new Uint8Array(n),
    glint,
    glintMask,
    crescentMask: new Uint8Array(n),
    crescentEta: 0,
    crescentContrast: 1,
    pupilCoverage: 0,
    width: w,
    height: h,
  });
  const { labels, stats } = connectedComponents(cand, w, h);
  if (stats.length <= 1) return empty();
  let best = -1;
  let bestScore = -1;
  for (let k = 1; k < stats.length; k++) {
    const s = stats[k]!;
    const d = Math.hypot(s.sx / s.area - iris.cx, s.sy / s.area - iris.cy);
    const sc = s.area / (1 + d / (0.25 * iris.r));
    if (sc > bestScore) {
      bestScore = sc;
      best = k;
    }
  }
  let pmask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] === best) pmask[i] = 1;
  pmask = fillHoles(pmask, w, h);

  // boundary pixels -> circle fit
  const bx: number[] = [];
  const by: number[] = [];
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!pmask[i]) continue;
      area++;
      sx += x;
      sy += y;
      if (
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        !pmask[i - 1] ||
        !pmask[i + 1] ||
        !pmask[i - w] ||
        !pmask[i + w]
      ) {
        bx.push(x);
        by.push(y);
      }
    }
  if (area < 5) return empty();
  let pupil = fitCircle(bx, by);
  if (!pupil || pupil.r > iris.r || pupil.r < 2)
    pupil = { cx: sx / area, cy: sy / area, r: Math.sqrt(area / Math.PI) };

  const disk = new Uint8Array(n);
  let diskN = 0;
  let both = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((x - pupil.cx) ** 2 + (y - pupil.cy) ** 2 <= pupil.r ** 2) {
        disk[i] = 1;
        diskN++;
        if (pmask[i]) both++;
      }
    }
  const pupilMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) pupilMask[i] = disk[i]! & pmask[i]!;

  const red = redMap(img);
  const crescentMask = new Uint8Array(n);
  let eta = 0;
  let contrast = 1;
  const inner: number[] = [];
  for (let i = 0; i < n; i++) if (pupilMask[i] && !glintMask[i]) inner.push(i);
  if (inner.length > 30 && flash) {
    const r = otsu(inner.map((i) => red[i]!));
    eta = r.eta;
    let hs = 0;
    let hn = 0;
    let ls = 0;
    let ln = 0;
    for (const i of inner) {
      if (red[i]! > r.threshold) {
        hs += red[i]!;
        hn++;
      } else {
        ls += red[i]!;
        ln++;
      }
    }
    if (hn && ln) {
      contrast = hs / hn / Math.max(ls / ln, 1e-3);
      const brightFrac = hn / inner.length;
      if (eta > 0.62 && contrast > 1.22 && brightFrac > 0.01 && brightFrac < 0.97) {
        const cm = new Uint8Array(n);
        for (const i of inner) if (red[i]! > r.threshold) cm[i] = 1;
        const cc = connectedComponents(cm, w, h);
        let b2 = 1;
        for (let k = 2; k < cc.stats.length; k++) if (cc.stats[k]!.area > cc.stats[b2]!.area) b2 = k;
        if (cc.stats.length > 1) for (let i = 0; i < n; i++) if (cc.labels[i] === b2) crescentMask[i] = 1;
      }
    }
  }
  return {
    iris,
    pupil,
    pupilMask,
    glint,
    glintMask,
    crescentMask,
    crescentEta: eta,
    crescentContrast: contrast,
    pupilCoverage: both / Math.max(diskN, 1),
    width: w,
    height: h,
  };
}
