"use client";
/** Per-device UI/research settings (localStorage, wrapped in try/catch). */
import { useCallback, useSyncExternalStore } from "react";
import type { DeviceProfile } from "./types";

export interface Settings {
  simulationMode: boolean;
  researchMode: boolean; // dark research styling + extra panels
  deviceId: string;
  customDevices: DeviceProfile[];
  astigmatismQuantification: boolean; // research flag; gated by validation status
  framesPerMeridian: number;
  meridians: number[];
  targetDistanceM: number;
  hfovDeg: number | null; // overrides device profile when calibrated
  personalHvidMm: number | null;
  pxPerMm: number | null; // screen calibration for the vision test
  apiUrl: string;
  storeCrops: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  simulationMode: true,
  researchMode: false,
  deviceId: "generic-phone-rear",
  customDevices: [],
  astigmatismQuantification: false,
  framesPerMeridian: 5,
  meridians: [0, 45, 90, 135],
  targetDistanceM: 1.0,
  hfovDeg: null,
  personalHvidMm: null,
  pxPerMm: null,
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
  storeCrops: true,
};

const KEY = "eyeref.settings.v1";
const listeners = new Set<() => void>();
let cache: Settings | null = null;

function read(): Settings {
  if (cache) return cache;
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    cache = raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULT_SETTINGS;
  } catch {
    cache = DEFAULT_SETTINGS;
  }
  return cache;
}

export function writeSettings(patch: Partial<Settings>) {
  cache = { ...read(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable - keep in memory */
  }
  listeners.forEach((l) => l());
}

export function useSettings(): [Settings, (p: Partial<Settings>) => void] {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => DEFAULT_SETTINGS,
  );
  return [s, useCallback((p: Partial<Settings>) => writeSettings(p), [])];
}
