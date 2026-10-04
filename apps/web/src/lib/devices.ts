/**
 * Device profiles (mirror of backend/eyeref/calibration/device_profiles.py).
 * Flash offsets are PLACEHOLDERS until measured with the Calibration Wizard.
 */
import type { CaptureMetadata, DeviceProfile } from "./types";

export const DEVICE_PROFILES: DeviceProfile[] = [
  {
    id: "generic-phone-rear",
    manufacturer: "generic",
    model: "Smartphone rear camera + LED torch",
    camera: "rear",
    hfovDeg: 68,
    flashOffsetMm: [0, -9],
    apertureDiameterMm: 2.8,
    gradientGain: null,
    gradientRelSd: 0.35,
    calibrationVersion: "uncalibrated",
    notes:
      "Placeholder geometry (flash 9 mm below lens in portrait). Measure your device in the Calibration Wizard.",
  },
  {
    id: "generic-webcam",
    manufacturer: "generic",
    model: "Laptop / desktop webcam (no eccentric source)",
    camera: "webcam",
    hfovDeg: 62,
    flashOffsetMm: null,
    apertureDiameterMm: 1.5,
    gradientGain: null,
    gradientRelSd: 0.35,
    calibrationVersion: "uncalibrated",
    notes: "Tracking and quality only. Photorefraction needs an eccentric light source.",
  },
  {
    id: "external-led-rig",
    manufacturer: "lab",
    model: "Development rig: camera + external LED",
    camera: "external",
    hfovDeg: 40,
    flashOffsetMm: [0, -6],
    apertureDiameterMm: 3,
    gradientGain: null,
    gradientRelSd: 0.35,
    calibrationVersion: "uncalibrated",
    notes: "Development-only eccentric LED next to the lens. Measure the offset precisely.",
  },
  {
    id: "simulated-phone",
    manufacturer: "simulation",
    model: "SIMULATED phone (renderer geometry)",
    camera: "rear",
    hfovDeg: 68,
    flashOffsetMm: [0, -9.4],
    apertureDiameterMm: 2.8,
    gradientGain: 5.78,
    gradientRelSd: 0.25,
    calibrationVersion: "sim-bench-1",
    simulated: true,
    notes: "SIMULATED. Gradient gain fitted on simulated bench data only.",
  },
];

export function getDevice(id: string, custom: DeviceProfile[] = []): DeviceProfile {
  return [...custom, ...DEVICE_PROFILES].find((d) => d.id === id) ?? DEVICE_PROFILES[1]!;
}

export function eccentricityMm(d: DeviceProfile): number | null {
  if (!d.flashOffsetMm) return null;
  return Math.max(Math.hypot(...d.flashOffsetMm) - d.apertureDiameterMm / 2, 0.1);
}

export function sourceAngleReferenceDeg(d: DeviceProfile): number | null {
  if (!d.flashOffsetMm) return null;
  const a = (Math.atan2(d.flashOffsetMm[1], d.flashOffsetMm[0]) * 180) / Math.PI;
  return ((a % 360) + 360) % 360;
}

export function effectiveSourceAngle(meta: CaptureMetadata, d: DeviceProfile): number | null {
  if (meta.sourceAngleImageDeg !== null) return ((meta.sourceAngleImageDeg % 360) + 360) % 360;
  const ref = sourceAngleReferenceDeg(d);
  return ref === null ? null : (((ref + meta.deviceRotationDeg) % 360) + 360) % 360;
}

/** Probed meridian in the eye's TABO frame: image source angle minus head roll, mod 180. */
export function meridianEyeDeg(meta: CaptureMetadata, d: DeviceProfile): number | null {
  const a = effectiveSourceAngle(meta, d);
  return a === null ? null : (((a - meta.headPose.rollDeg) % 180) + 180) % 180;
}

export function effectiveEccentricity(meta: CaptureMetadata, d: DeviceProfile): number | null {
  return meta.eccentricityMm ?? eccentricityMm(d);
}
