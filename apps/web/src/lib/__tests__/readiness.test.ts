import { describe, expect, it } from "vitest";
import { burstSummary, evaluateReadiness, flashMissing, type ReadinessInput } from "../protocol/readiness";
import { frame } from "./fixtures";

const base: ReadinessInput = {
  face: true,
  distanceM: 1,
  targetDistanceM: 1,
  luma: 0.2,
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  gaze: 0.02,
  blink: 0.05,
  motionPx: 0.5,
  pupilMm: null,
  grade: "excellent",
  flashAvailable: true,
  deviceRotationErrorDeg: null,
};
const light = (i: ReadinessInput) => evaluateReadiness(i).indicators.find((x) => x.key === "light")!;

describe("the room light check", () => {
  it("goes by the pupil when one is measured, whatever the camera's exposure makes of the face", () => {
    // the camera brightens a face in a dark room, so a bright face with wide pupils is a dim room
    expect(light({ ...base, luma: 0.7, pupilMm: 6 })).toMatchObject({ value: "Dim enough", state: "ok" });
    expect(light({ ...base, luma: 0.1, pupilMm: 3 })).toMatchObject({ value: "Too bright", state: "warn" });
  });
  it("never blocks a capture", () => {
    expect(evaluateReadiness({ ...base, luma: 0.9 }).ready).toBe(true);
    expect(evaluateReadiness({ ...base, luma: 0.01 }).ready).toBe(true);
  });
  it("says to add some light when the face cannot be found in the dark", () => {
    const face = evaluateReadiness({ ...base, face: false, luma: 0.02 }).indicators.find(
      (x) => x.key === "face",
    );
    expect(face?.hint).toMatch(/Too dark to find the face/);
  });
});

describe("a missing light source", () => {
  it("says what to change", () => {
    const phone = { hasSource: true, deviceCamera: "rear" };
    expect(flashMissing({ ...phone, facing: "environment", torch: true })).toBeNull();
    expect(flashMissing({ ...phone, facing: "user", torch: false })).toMatch(/back camera/);
    expect(flashMissing({ ...phone, facing: "environment", torch: false })).toMatch(/browser/);
    expect(flashMissing({ hasSource: false, deviceCamera: "webcam", facing: "user", torch: false })).toMatch(
      /no light beside the lens/,
    );
    const ind = evaluateReadiness({ ...base, flashAvailable: false, flashMissingHint: "switch" });
    expect(ind.ready).toBe(false);
    expect(ind.indicators.find((x) => x.key === "flash")?.hint).toBe("switch");
  });
});

describe("a capture's summary", () => {
  it("counts usable images and names the commonest reasons for the rest", () => {
    const bad = (h: string[]) => {
      const f = frame("OD", 0, -2, "reject");
      f.quality.hardFailures = h;
      return f;
    };
    const recs = [
      frame("OD", 0, -2),
      frame("OS", 0, -2),
      bad(["no_red_reflex", "motion"]),
      bad(["no_red_reflex"]),
      bad(["pupil_too_small"]),
    ];
    const s = burstSummary(recs, 5);
    expect(s).toMatchObject({ usable: 2, total: 10 });
    expect(s.reasons[0]).toBe("No red reflex (light source off?)");
    expect(s.reasons).toContain("Face lost in some frames");
  });
});
