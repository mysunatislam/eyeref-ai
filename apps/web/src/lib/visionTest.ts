/** Tumbling-E acuity helpers. Visual acuity is reported separately and never feeds refraction. */
import type { VisionTestResult } from "./types";

export type Dir = "up" | "down" | "left" | "right";
export const DIRS: Dir[] = ["up", "right", "down", "left"];
export const LETTERS_PER_LINE = 5;
export const START_LOGMAR = 0.7;
export const MIN_LOGMAR = -0.2;

/** Optotype height in mm at distance d (5 arcmin at logMAR 0). */
export function optotypeMm(logMar: number, distanceM: number): number {
  const arcmin = 5 * 10 ** logMar;
  return distanceM * 1000 * Math.tan(((arcmin / 60) * Math.PI) / 180);
}

export function snellenFromLogMar(logMar: number, base = 6): string {
  return `${base}/${(base * 10 ** logMar).toFixed(base === 6 ? 1 : 0).replace(/\.0$/, "")}`;
}

/** ETDRS-style letter-by-letter score: top line + 0.1 − 0.02 per letter read correctly. */
export function scoreLogMar(lines: { logMar: number; correct: number }[]): number | null {
  if (!lines.length || lines[0]!.correct < 3) return null;
  const top = Math.max(...lines.map((l) => l.logMar));
  const total = lines.reduce((s, l) => s + l.correct, 0);
  return +(top + 0.1 - 0.02 * total).toFixed(2);
}

const KEY = "eyeref.vision.v1";
export function loadVision(): VisionTestResult[] {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as VisionTestResult[];
  } catch {
    return [];
  }
}
export function saveVision(r: VisionTestResult) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([r, ...loadVision()].slice(0, 100)));
  } catch {
    /* storage unavailable */
  }
}
