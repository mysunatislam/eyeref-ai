"use client";
/**
 * Device roll about the camera's optical axis, from the gravity vector (DeviceMotion).
 * 0 deg = portrait upright; positive = counter-clockwise as seen from the subject (TABO sense
 * for a rear camera facing the subject). Falls back to null (manual meridian entry) when the
 * sensor is unavailable, e.g. on laptops.
 */
import { useCallback, useEffect, useState } from "react";

export function rollFromGravity(gx: number, gy: number): number {
  // gravity in device coords; upright portrait -> (0, -9.8) on most browsers
  const a = (Math.atan2(gx, -gy) * 180) / Math.PI;
  return ((a % 360) + 360) % 360;
}

export function useDeviceRotation() {
  const [rollDeg, setRollDeg] = useState<number | null>(null);
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied" | "unsupported">("unknown");

  const request = useCallback(async () => {
    const DME = (
      globalThis as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }
    ).DeviceMotionEvent;
    if (!DME) return setPermission("unsupported");
    if (typeof DME.requestPermission === "function") {
      try {
        setPermission((await DME.requestPermission()) === "granted" ? "granted" : "denied");
      } catch {
        setPermission("denied");
      }
    } else setPermission("granted");
  }, []);

  useEffect(() => {
    if (permission !== "granted") return;
    let last = 0;
    const onMotion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x === null || g.y === null) return;
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      setRollDeg(rollFromGravity(g.x, g.y));
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [permission]);

  return { rollDeg, permission, request };
}
