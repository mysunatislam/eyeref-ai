/** Minimal image utilities on RGBA buffers (ImageData-compatible, works in Node tests). */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function lumaMap(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++)
    out[i] = (0.299 * d[4 * i]! + 0.587 * d[4 * i + 1]! + 0.114 * d[4 * i + 2]!) / 255;
  return out;
}

export function redMap(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = img.data[4 * i]! / 255;
  return out;
}

export function redChromaMap(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const r = d[4 * i]! + 1;
    out[i] = r / (r + d[4 * i + 1]! + 1 + d[4 * i + 2]! + 1);
  }
  return out;
}

export function saturationMap(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const r = d[4 * i]!;
    const g = d[4 * i + 1]!;
    const b = d[4 * i + 2]!;
    const mx = Math.max(r, g, b);
    out[i] = (mx - Math.min(r, g, b)) / (mx + 1e-6);
  }
  return out;
}

/** Variance of the 4-neighbour Laplacian of luma inside an optional mask (focus measure). */
export function laplacianVariance(img: RgbaImage, mask?: Uint8Array): number {
  const L = lumaMap(img);
  const w = img.width;
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < img.height - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask && !mask[i]) continue;
      const v = L[i - 1]! + L[i + 1]! + L[i - w]! + L[i + w]! - 4 * L[i]!;
      s += v;
      s2 += v * v;
      n++;
    }
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

/** Otsu threshold on values (0..1-ish); returns threshold and eta = sigma_b^2 / sigma_t^2. */
export function otsu(values: ArrayLike<number>, bins = 64): { threshold: number; eta: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    n++;
  }
  if (n < 8 || hi - lo < 1e-9) return { threshold: lo, eta: 0 };
  const hist = new Float64Array(bins);
  const width = (hi - lo) / bins;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    hist[Math.min(bins - 1, Math.floor((v - lo) / width))]! += 1;
  }
  let muT = 0;
  for (let k = 0; k < bins; k++) muT += (hist[k]! / n) * (lo + (k + 0.5) * width);
  let sT = 0;
  for (let k = 0; k < bins; k++) sT += (hist[k]! / n) * (lo + (k + 0.5) * width - muT) ** 2;
  let w0 = 0;
  let mu = 0;
  let best = -1;
  let bestK = 0;
  for (let k = 0; k < bins; k++) {
    const p = hist[k]! / n;
    w0 += p;
    mu += p * (lo + (k + 0.5) * width);
    const w1 = 1 - w0;
    if (w0 < 1e-9 || w1 < 1e-9) continue;
    const sb = (muT * w0 - mu) ** 2 / (w0 * w1);
    if (sb > best) {
      best = sb;
      bestK = k;
    }
  }
  return { threshold: lo + (bestK + 1) * width, eta: sT > 0 ? best / sT : 0 };
}

/** 8-connected components of a binary mask. Returns labels (0 = background) and per-label stats. */
export function connectedComponents(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h);
  const stats: { area: number; sx: number; sy: number }[] = [{ area: 0, sx: 0, sy: 0 }];
  const stack: number[] = [];
  let next = 1;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    const st = { area: 0, sx: 0, sy: 0 };
    labels[i] = next;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w;
      const y = (j - x) / w;
      st.area++;
      st.sx += x;
      st.sy += y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (mask[k] && !labels[k]) {
            labels[k] = next;
            stack.push(k);
          }
        }
      }
    }
    stats.push(st);
    next++;
  }
  return { labels, stats };
}

/** Fill holes: background pixels not connected to the border become foreground. */
export function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask);
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const j = stack.pop()!;
    const x = j % w;
    const y = (j - x) / w;
    if (x > 0) push(j - 1);
    if (x < w - 1) push(j + 1);
    if (y > 0) push(j - w);
    if (y < h - 1) push(j + w);
  }
  for (let i = 0; i < w * h; i++) if (!outside[i]) out[i] = 1;
  return out;
}

export function erode3(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++)
        for (let dx = -1; dx <= 1; dx++) if (!mask[(y + dy) * w + x + dx]) all = 0;
      out[y * w + x] = all;
    }
  return out;
}

export function dilate3(mask: Uint8Array, w: number, h: number, iterations = 1): Uint8Array {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let any = 0;
        for (let dy = -1; dy <= 1 && !any; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && cur[ny * w + nx]) {
              any = 1;
              break;
            }
          }
        out[y * w + x] = any;
      }
    cur = out;
  }
  return cur;
}

/** Kasa algebraic least-squares circle fit. */
export function fitCircle(xs: number[], ys: number[]): { cx: number; cy: number; r: number } | null {
  const n = xs.length;
  if (n < 5) return null;
  // normal equations for [a b c] in x^2+y^2 + a x + b y + c = 0
  let sxx = 0,
    sxy = 0,
    syy = 0,
    sx = 0,
    sy = 0,
    sxz = 0,
    syz = 0,
    sz = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    const z = -(x * x + y * y);
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const b = [sxz, syz, sz];
  const det = (m: number[][]) =>
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const D = det(A);
  if (Math.abs(D) < 1e-9) return null;
  const sol = [0, 1, 2].map((c) => det(A.map((row, r) => row.map((v, k) => (k === c ? b[r]! : v)))) / D);
  const cx = -sol[0]! / 2;
  const cy = -sol[1]! / 2;
  const r2 = cx * cx + cy * cy - sol[2]!;
  return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : null;
}

/** Crop + scale a region of a canvas-like source into a new RgbaImage (browser only). */
export function imageDataToRgba(d: ImageData): RgbaImage {
  return { width: d.width, height: d.height, data: d.data };
}
