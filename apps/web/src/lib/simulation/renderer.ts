/**
 * Deterministic synthetic eye renderer - SIMULATION / DEVELOPMENT MODE ONLY.
 * Port of backend/eyeref/simulation/renderer.py. Output images are always labelled SIMULATED.
 */
import { createImage, type RgbaImage } from "../cv/image";
import {
  crescentWidthM,
  deadZoneHalfwidth,
  defocusRelativeToCamera,
  type EccentricGeometry,
} from "../optics/photorefraction";
import { rxPowerInMeridian, type SphCylAxis } from "../optics/powerVector";
import { createRng, normal, uniform } from "../random";

export interface SyntheticEyeParams {
  refraction: SphCylAxis;
  accommodationD: number;
  pupilDiameterMm: number;
  irisDiameterMm: number;
  workingDistanceM: number;
  eccentricityMm: number;
  sourceAngleImageDeg: number;
  headRollDeg: number;
  sizePx: number;
  irisRadiusPx: number;
  irisRgb: [number, number, number];
  skinRgb: [number, number, number];
  fundusReflectance: number;
  gradientGain: number;
  gazeOffset: [number, number];
  eyelidOpening: number;
  blurSigmaPx: number;
  exposure: number;
  noiseSd: number;
  flashOn: boolean;
  seed: number;
}

export const DEFAULT_EYE: SyntheticEyeParams = {
  refraction: { sph: 0, cyl: 0, axis: null },
  accommodationD: 0,
  pupilDiameterMm: 6,
  irisDiameterMm: 11.7,
  workingDistanceM: 1,
  eccentricityMm: 8,
  sourceAngleImageDeg: 270,
  headRollDeg: 0,
  sizePx: 160,
  irisRadiusPx: 52,
  irisRgb: [92, 64, 44],
  skinRgb: [176, 132, 108],
  fundusReflectance: 0.85,
  gradientGain: 0.18,
  gazeOffset: [0, 0],
  eyelidOpening: 0.9,
  blurSigmaPx: 0.6,
  exposure: 1,
  noiseSd: 3,
  flashOn: true,
  seed: 0,
};

export interface SyntheticTruth {
  pupilCenter: [number, number];
  pupilRadiusPx: number;
  irisRadiusPx: number;
  meridianEyeDeg: number;
  powerInMeridianD: number;
  defocusD: number;
  crescentWidthPx: number;
  crescentSide: -1 | 0 | 1;
  inDeadZone: boolean;
}

const soft = (x: number, w: number) =>
  1 / (1 + Math.exp(-Math.max(-60, Math.min(60, x / Math.max(w, 1e-3)))));

function gaussianBlur(buf: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return buf;
  const rad = Math.max(1, Math.ceil(3 * sigma));
  const k: number[] = [];
  let ks = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    ks += v;
  }
  const kn = k.map((v) => v / ks);
  const tmp = new Float32Array(buf.length);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -rad; i <= rad; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          s += kn[i + rad]! * buf[(y * w + xx) * 3 + c]!;
        }
        tmp[(y * w + x) * 3 + c] = s;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -rad; i <= rad; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          s += kn[i + rad]! * tmp[(yy * w + x) * 3 + c]!;
        }
        out[(y * w + x) * 3 + c] = s;
      }
  }
  return out;
}

export function renderEye(params: Partial<SyntheticEyeParams>): { image: RgbaImage; truth: SyntheticTruth } {
  const p: SyntheticEyeParams = { ...DEFAULT_EYE, ...params };
  const rng = createRng(p.seed);
  const n = p.sizePx;
  const c = (n - 1) / 2;
  const irisR = p.irisRadiusPx;
  const pupilR = (p.pupilDiameterMm / p.irisDiameterMm) * irisR;
  const buf = new Float32Array(n * n * 3);

  const eyeMeridian = (((p.sourceAngleImageDeg - p.headRollDeg) % 180) + 180) % 180;
  const power = rxPowerInMeridian(p.refraction, eyeMeridian) - p.accommodationD;
  const geom: EccentricGeometry = {
    workingDistanceM: p.workingDistanceM,
    eccentricityM: p.eccentricityMm / 1000,
    pupilDiameterM: p.pupilDiameterMm / 1000,
  };
  const defocus = defocusRelativeToCamera(power, p.workingDistanceM);
  const { widthM, side } = crescentWidthM(power, geom);
  const sPx = (widthM / geom.pupilDiameterM) * 2 * pupilR;
  const ua = (p.sourceAngleImageDeg * Math.PI) / 180;
  const ux = Math.cos(ua);
  const uy = -Math.sin(ua);
  const dz = deadZoneHalfwidth(geom);
  const g = p.gradientGain * Math.max(-1, Math.min(1, -defocus / dz));
  const phases = [0, 1, 2, 3].map(() => uniform(rng, 0, 2 * Math.PI));
  const lidHalf = p.eyelidOpening * irisR * 1.05;
  const gx = c + p.gazeOffset[0] * pupilR + 0.04 * pupilR * ux;
  const gy = c + p.gazeOffset[1] * pupilR + 0.04 * pupilR * uy;
  const gsig = Math.max(1.1, 0.07 * pupilR);

  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = x - c;
      const dy = y - c;
      const rr = Math.hypot(dx, dy);
      let col = [...p.skinRgb] as number[];
      const almond = (dy / Math.max(lidHalf, 1)) ** 2 + (dx / (irisR * 2.3)) ** 2;
      const sclera = soft(1 - almond, 0.04);
      col = col.map((v, k) => v * (1 - sclera) + [228, 222, 216][k]! * sclera);
      const th = Math.atan2(dy, dx);
      let tex =
        0.06 * Math.sin(7 * th + phases[0]!) +
        0.05 * Math.sin(13 * th + phases[1]!) +
        0.04 * Math.sin(29 * th + phases[2]!) +
        0.03 * Math.sin(53 * th + phases[3]!);
      tex *= 0.6 + 0.4 * (rr / irisR);
      const limbal = 1 - 0.45 * Math.min(1, Math.max(0, (rr / irisR - 0.86) / 0.14));
      const irisM = soft(irisR - rr, 0.8) * sclera;
      col = col.map((v, k) => v * (1 - irisM) + p.irisRgb[k]! * (1 + tex) * limbal * irisM);
      let reflex: number[];
      if (p.flashOn) {
        const proj = (dx * ux + dy * uy) / Math.max(pupilR, 1e-6);
        let lum = 0.55 * p.fundusReflectance * (1 + g * proj);
        if (side !== 0 && sPx > 0.3)
          lum += 0.42 * p.fundusReflectance * soft(side * proj * pupilR - (pupilR - sPx), 0.9);
        reflex = [lum * 255 * 0.95, lum * 255 * 0.3, lum * 255 * 0.16];
      } else reflex = [14, 10, 10];
      const pm = soft(pupilR - rr, 0.7) * sclera;
      col = col.map((v, k) => v * (1 - pm) + reflex[k]! * pm);
      if (p.flashOn) {
        const gl = Math.exp(-((x - gx) ** 2 + (y - gy) ** 2) / (2 * gsig * gsig)) * 255 * 1.4;
        col = col.map((v) => v + gl);
      }
      const i = (y * n + x) * 3;
      buf[i] = col[0]! * p.exposure;
      buf[i + 1] = col[1]! * p.exposure;
      buf[i + 2] = col[2]! * p.exposure;
    }
  const blurred = gaussianBlur(buf, n, n, p.blurSigmaPx);
  const img = createImage(n, n);
  for (let i = 0; i < n * n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = blurred[i * 3 + k]!;
      const noisy = v + normal(rng) * Math.sqrt(Math.max(v, 0)) * 0.25 + normal(rng, 0, p.noiseSd);
      img.data[i * 4 + k] = Math.max(0, Math.min(255, Math.round(noisy)));
    }
    img.data[i * 4 + 3] = 255;
  }
  return {
    image: img,
    truth: {
      pupilCenter: [c, c],
      pupilRadiusPx: pupilR,
      irisRadiusPx: irisR,
      meridianEyeDeg: eyeMeridian,
      powerInMeridianD: power,
      defocusD: defocus,
      crescentWidthPx: sPx,
      crescentSide: side,
      inDeadZone: side === 0,
    },
  };
}
