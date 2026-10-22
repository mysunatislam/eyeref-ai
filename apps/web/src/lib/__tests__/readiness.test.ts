import { describe, expect, it } from "vitest";
import { HARD_FAILURE_TEXT } from "../cv/quality";
import {
  burstSummary,
  captureDetails,
  evaluateReadiness,
  FAILURE_FIX,
  flashMissing,
  type ReadinessInput,
} from "../protocol/readiness";
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
    // five of the ten eye images never came: the face was lost in those frames
    expect(s.reasons[0]).toBe("Face lost in some frames");
    expect(s.reasons[1]).toBe("No red reflex (light source off?)");
    expect(s.fix).toBe(FAILURE_FIX.face_lost);
  });

  it("says what to change for the commonest reason, and nothing once enough images are usable", () => {
    const glare = () => {
      const f = frame("OD", 0, -2, "reject");
      f.quality.hardFailures = ["excessive_glare"];
      return f;
    };
    const s = burstSummary([frame("OD", 0, -2), frame("OS", 0, -2), ...Array.from({ length: 8 }, glare)], 5);
    expect(s.reasons).toEqual(["Corneal glare covers the pupil"]);
    expect(s.fix).toMatch(/only this phone's flash/);
    expect(
      burstSummary(
        Array.from({ length: 10 }, () => frame("OD", 0, -2)),
        5,
      ).fix,
    ).toBeUndefined();
  });

  it("has a fix for every reason an image can be rejected", () => {
    for (const k of Object.keys(HARD_FAILURE_TEXT)) expect(FAILURE_FIX[k], k).toBeTruthy();
  });
});

describe("a capture's details to paste into a message", () => {
  it("lists the camera, the summary and each image's quality, without eye results", () => {
    const bad = frame("OS", 0, -2, "reject");
    bad.quality.hardFailures = ["reflex_saturated"];
    const text = captureDetails([frame("OD", 0, -2), bad], 1, {
      width: 1920,
      height: 1080,
      zoom: 2,
      flash: true,
      lowLight: false,
      userAgent: "test-agent",
    });
    const lines = text.split("\n");
    expect(lines[1]).toContain("test-agent");
    expect(lines[2]).toMatch(/^camera 1920x1080, zoom 2\.0x, flash found/);
    expect(lines[3]).toMatch(/^usable 1 of 2/);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toMatch(/^OS #\d+: reject \[reflex_saturated\] pupil/);
    // no refraction or estimate leaves the device this way
    expect(text).not.toMatch(/sph|cyl|axis|diopt|refraction|power/i);
  });
});
