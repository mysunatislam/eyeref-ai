"use client";
/**
 * The participant the stage 1 page is working through, kept in this browser so that going off to capture a
 * lens and coming back does not lose the code or the trial frame's measurements. It holds no name.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_VERTEX_MM, STAGE1_CODE } from "./stage1";

export interface Stage1Setup {
  code: string;
  /** the spherical equivalent of a correction held in the trial frame (D); 0 for contacts or none */
  correctionInFrameD: number;
  vertexMm: number;
}

export const EMPTY_SETUP: Stage1Setup = { code: "", correctionInFrameD: 0, vertexMm: DEFAULT_VERTEX_MM };

const KEY = "eyeref.stage1.setup.v1";
const listeners = new Set<() => void>();
let cache: { raw: string | null; setup: Stage1Setup } = { raw: null, setup: EMPTY_SETUP };

const ok = (v: unknown): v is Stage1Setup => {
  const s = v as Partial<Stage1Setup> | null;
  return (
    !!s &&
    typeof s.code === "string" &&
    (s.code === "" || STAGE1_CODE.test(s.code)) &&
    typeof s.correctionInFrameD === "number" &&
    Number.isFinite(s.correctionInFrameD) &&
    typeof s.vertexMm === "number" &&
    Number.isFinite(s.vertexMm)
  );
};

function read(): Stage1Setup {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return EMPTY_SETUP;
  }
  if (raw === cache.raw) return cache.setup;
  let setup = EMPTY_SETUP;
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (ok(v)) setup = { code: v.code, correctionInFrameD: v.correctionInFrameD, vertexMm: v.vertexMm };
  } catch {
    setup = EMPTY_SETUP;
  }
  cache = { raw, setup };
  return setup;
}

export function useStage1Setup(): Stage1Setup {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => EMPTY_SETUP,
  );
}

export function saveStage1Setup(setup: Stage1Setup) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(setup));
  } catch {
    // a browser that keeps nothing simply asks for the code again
  } finally {
    listeners.forEach((l) => l());
  }
}
