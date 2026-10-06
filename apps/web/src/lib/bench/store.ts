"use client";
/**
 * The bench run in progress, kept in this browser so a reload or a closed tab does not lose the steps
 * already captured. A run holds features and quality scores, never an image.
 */
import { useSyncExternalStore } from "react";
import type { BenchRun } from "./run";
import { benchRunProblem } from "./run";

const KEY = "eyeref.bench.run.v1";
const listeners = new Set<() => void>();
let cache: { raw: string | null; run: BenchRun | null } = { raw: null, run: null };

function read(): BenchRun | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (raw === cache.raw) return cache.run;
  let run: BenchRun | null = null;
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    run = v && benchRunProblem(v) === null ? (v as BenchRun) : null;
  } catch {
    run = null;
  }
  cache = { raw, run };
  return run;
}

/** The run in progress, or null. */
export function useRunInProgress(): BenchRun | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => null,
  );
}

/** False when the browser would not keep it (private mode, or storage full). */
export function keepRunInProgress(run: BenchRun): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(run));
    return true;
  } catch {
    return false;
  } finally {
    listeners.forEach((l) => l());
  }
}

export function dropRunInProgress() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}
