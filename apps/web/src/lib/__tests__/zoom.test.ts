import { describe, expect, it } from "vitest";
import { estimateDistance, IRIS_MIN_PX, IRIS_TARGET_PX, MAX_AUTO_ZOOM, nextZoom } from "../protocol/live";
import { SIM_DEVICE } from "../simulation/session";
import type { FaceObservation } from "../tracking/faceTracker";

const range = { min: 1, max: 8, step: 0.1 };

describe("live camera zoom", () => {
  it("zooms in until the iris spans about the target", () => {
    const z = nextZoom(17, 1, range)!;
    expect(z).toBeCloseTo(IRIS_TARGET_PX / 17, 1);
    expect(nextZoom(17 * z, z, range)).toBeNull(); // once there, it stays
  });
  it("stays within the camera's range and the cap", () => {
    expect(nextZoom(5, 1, range)).toBe(MAX_AUTO_ZOOM);
    expect(nextZoom(5, MAX_AUTO_ZOOM, range)).toBeNull(); // can zoom no further
    expect(nextZoom(17, 1, { min: 1, max: 2, step: 0.5 })).toBe(2);
    expect(nextZoom(17, 1, null)).toBeNull();
  });
  it("leaves a big enough iris alone, and zooms out only when far past the target", () => {
    expect(nextZoom(IRIS_MIN_PX, 1, range)).toBeNull();
    expect(nextZoom(150, 1, range)).toBeNull();
    expect(nextZoom(150, 3, range)).toBe(1); // back to the lens, no lower
    expect(nextZoom(120, 3, range)).toBeCloseTo((3 * IRIS_TARGET_PX) / 120, 1);
  });
  it("reads distance through the zoom", () => {
    const eye = (r: number) => ({ iris: { cx: 0, cy: 0, r } }) as FaceObservation["eyes"]["OD"];
    const obs = (r: number) => ({ eyes: { OD: eye(r), OS: eye(r) } }) as FaceObservation;
    const ctx = {
      device: SIM_DEVICE,
      hfovDeg: 65,
      hvidMm: 11.7,
      ageGroup: "adult_18_39" as const,
      manualDistanceM: null,
    };
    const plain = estimateDistance(obs(8.5), 1920, ctx).distanceM;
    const zoomed = estimateDistance(obs(17), 1920, { ...ctx, zoom: 2 }).distanceM;
    expect(zoomed).toBeCloseTo(plain, 6);
  });
});
