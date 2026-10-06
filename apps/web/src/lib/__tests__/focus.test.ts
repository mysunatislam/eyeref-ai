import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { snake } from "../api";
import { buildReport, focusModelFor } from "../inference/fusion";
import { focusPosterior, type EyeReading } from "../inference/focus";
import { thresholdsForAge } from "../optics/classification";
import { focusOnLight, makeSubject } from "../simulation/session";
import type { AgeGroup } from "../types";
import { frame } from "./fixtures";

const FIXTURES = resolve(__dirname, "../../../../../shared/fixtures");

const R = (meanD: number, sdD: number): EyeReading => ({ kind: "reading", meanD, sdD });
const NONE: EyeReading = { kind: "none" };
const post = (od: EyeReading, os: EyeReading, age: AgeGroup, d = 1) =>
  focusPosterior({ OD: od, OS: os }, age, d, thresholdsForAge(age))!;

describe("focusing on the light", () => {
  it("leaves an eye beyond the light's reach as it reads", () => {
    const f = post(R(-3, 0.45), R(-3, 0.45), "adult_18_39");
    expect(f.pFocusing).toBeLessThan(0.01);
    expect(f.eyes.OD!.medianD).toBeCloseTo(-3, 1);
    expect(f.eyes.OD!.ci95[1] - f.eyes.OD!.ci95[0]).toBeCloseTo(2 * 1.96 * 0.45, 1);
    expect(f.eyes.OD!.classProbabilities.myopia).toBeGreaterThan(0.99);
  });

  it("makes an eye that can see the light no more myopic than it reads, and able to hide hyperopia", () => {
    const f = post(R(-0.75, 0.45), R(-0.75, 0.45), "adult_18_39");
    const od = f.eyes.OD!;
    expect(od.ci95[0]).toBeGreaterThan(-0.75 - 2 * 0.45);
    expect(od.ci95[1]).toBeGreaterThan(5);
    expect(f.pFocusing).toBeGreaterThan(0.3);
    expect(od.classProbabilities.hyperopia).toBeGreaterThan(0.1);
  });

  it("hides no more than the eyes can focus at that age", () => {
    const f = post(R(-0.75, 0.3), R(-0.75, 0.3), "adult_60_plus");
    expect(f.amplitudeD).toBe(1);
    expect(f.eyes.OD!.ci95[1]).toBeLessThan(-0.75 + 1 + 2 * 0.3);
    expect(f.eyes.OD!.medianD).toBeGreaterThan(-0.75);
  });

  it("moves both eyes by the same amount, so the difference between them is kept", () => {
    const f = post(R(-4, 0.45), R(-0.8, 0.45), "adult_18_39");
    expect(f.eyes.OD!.medianD - f.eyes.OS!.medianD).toBeCloseTo(-3.2, 0);
    // the eyes focus for the less myopic eye; the other cannot see the light but is moved all the same
    expect(f.eyes.OD!.ci95[1]).toBeGreaterThan(-4 + 2 * 0.45);
  });

  it("lets an eye with no reading follow its fellow", () => {
    const f = post(R(-3, 0.45), NONE, "adult_18_39");
    expect(f.eyes.OS).toBeNull();
    expect(f.eyes.OD!.ci95[1] - f.eyes.OD!.ci95[0]).toBeLessThan(2);
  });

  it("no longer rules out hyperopia in the dead zone", () => {
    const dz: EyeReading = { kind: "interval", loD: -2.33, hiD: 0.33, sdD: 0.85 };
    const f = post(dz, dz, "child_3_7");
    expect(f.eyes.OD!.ci95[0]).toBeGreaterThan(-3);
    expect(f.eyes.OD!.ci95[1]).toBeGreaterThan(10);
  });

  it("is none when nothing was measured", () => {
    expect(focusPosterior({ OD: NONE, OS: NONE }, "teen", 1, thresholdsForAge("teen"))).toBeNull();
  });
});

describe("the simulated eyes' focusing", () => {
  const s = (od: number, os: number, ageGroup: AgeGroup = "adult_18_39") => ({
    ...makeSubject("FOCUS", ageGroup),
    od: { sph: od, cyl: 0, axis: null },
    os: { sph: os, cyl: 0, axis: null },
    focusResponse: 0.8,
  });
  it("clears the eye that needs least, and stays relaxed when neither can see the light", () => {
    expect(focusOnLight(s(0, 0), 1)).toBeCloseTo(0.8, 6);
    expect(focusOnLight(s(2, 0.5), 1)).toBeCloseTo(0.8 * 1.5, 6);
    expect(focusOnLight(s(-0.5, -3), 1)).toBeCloseTo(0.8 * 0.5, 6);
    expect(focusOnLight(s(-3, -3), 1)).toBe(0);
    expect(focusOnLight(s(0, 0), 2)).toBeCloseTo(0.4, 6);
  });
  it("cannot focus beyond its age's amplitude", () => {
    expect(focusOnLight(s(4, 4, "adult_60_plus"), 1)).toBe(1);
  });
});

const report = (od: number | null, os: number | null, ageGroup: AgeGroup, focusModel?: boolean) =>
  buildReport({
    frames: [0, 45, 90, 135].flatMap((rot) =>
      Array.from({ length: 5 }, () => [frame("OD", rot, od), frame("OS", rot, os)]).flat(),
    ),
    ageGroup,
    deviceId: "simulated-phone",
    calibrationVersion: "c",
    estimator: { name: "t", version: "0", kind: "test" },
    extractorVersion: "x",
    focusModel,
  });

describe("a report that allows for focusing", () => {
  it("gives a young eye that could focus on the light a range and no class, not a number", () => {
    const r = report(-0.9, -0.9, "adult_18_39");
    expect(r.eyes.OD).toMatchObject({
      outputLevel: "screening",
      seD: null,
      refractiveClass: null,
      focusLimited: true,
    });
    expect(r.eyes.OD.message).toMatch(/no more myopic than −1\.\d\d D; whether it is emmetropic/);
    expect(r.eyes.OD.refractionRange95![1]).toBeGreaterThan(5);
    expect(r.interpretation).toContain("An eye that can focus on the light hides hyperopia");
    expect(r.focus!.pFocusing).toBeGreaterThan(0.3);
  });

  it("says a child's hyperopia needs eye drops to find", () => {
    const r = report(-0.3, -0.3, "child_3_7");
    expect(r.eyes.OD.message).toContain("an eye examination with eye drops");
    expect(r.interpretation).toContain("only found with eye drops");
  });

  it("calls an eye myopic only when its whole range is", () => {
    const r = report(-4, -0.8, "adult_18_39");
    expect(r.eyes.OD).toMatchObject({ refractiveClass: "myopia", focusLimited: true, seD: null });
    expect(r.eyes.OD.message).toMatch(/^This eye is myopic, between −\d\.\d\d D and −\d\.\d\d D\./);
    expect(r.eyes.OS.refractiveClass).toBeNull();
    expect(r.anisometropiaProbability!).toBeGreaterThan(0.9);
  });

  it("moves an older eye's number toward plus by what it could focus", () => {
    const r = report(-0.75, -0.75, "adult_60_plus");
    expect(r.eyes.OD.outputLevel).toBe("quantitative");
    expect(r.eyes.OD.seD!).toBeGreaterThan(-0.75);
    expect(r.eyes.OD.message).toContain("allowing for the eyes focusing on the light");
  });

  it("keeps a clear myope's number as it reads", () => {
    const r = report(-3, -3, "adult_18_39");
    expect(r.eyes.OD.outputLevel).toBe("quantitative");
    expect(r.eyes.OD.seD!).toBeCloseTo(-3, 1);
    expect(r.eyes.OD.message).not.toContain("focusing");
  });

  it("no longer says the dead zone rules out hyperopia in a young eye", () => {
    const r = report(null, null, "adult_18_39");
    expect(r.eyes.OD.outputLevel).toBe("screening");
    expect(r.eyes.OD.message).toContain("can hide hyperopia here");
  });

  it("allows for focusing after a learned model only when it learned what the camera saw", () => {
    expect(focusModelFor("physics-heuristic")).toBe(true);
    expect(focusModelFor("ml", "optical")).toBe(true);
    expect(focusModelFor("ml", "clinical")).toBe(false);
    expect(focusModelFor("ml")).toBe(false);
    const learned = (learnedTarget?: "optical" | "clinical") =>
      buildReport({
        frames: [0, 90].flatMap((rot) => Array.from({ length: 5 }, () => frame("OD", rot, -0.9))),
        ageGroup: "adult_18_39",
        deviceId: "simulated-phone",
        calibrationVersion: "c",
        estimator: { name: "m", version: "0", kind: "ml", learnedTarget },
        extractorVersion: "x",
      });
    expect(learned("optical").focus).not.toBeNull();
    expect(learned("clinical").focus).toBeNull();
    expect(learned().focus).toBeNull();
  });

  it("takes the reading as it stands when the focusing model is off, as stage 1 does", () => {
    const r = report(-0.9, -0.9, "adult_18_39", false);
    expect(r.focus).toBeNull();
    expect(r.eyes.OD.outputLevel).toBe("quantitative");
    expect(r.eyes.OD.seD!).toBeCloseTo(-0.9, 1);
    expect(r.eyes.OD.refractionRange95).toBeUndefined();
    expect(r.eyes.OD.notes.join(" ")).toContain("Not corrected for focusing on the light");
  });
});

describe("the Python twin", () => {
  it("is given cases it must match", () => {
    const readings: [string, EyeReading, EyeReading, AgeGroup, number][] = [
      ["myope", R(-3, 0.45), R(-3, 0.45), "adult_18_39", 1],
      ["reads -0.75", R(-0.75, 0.45), R(-0.75, 0.45), "adult_18_39", 1],
      ["older eye", R(-0.75, 0.3), R(-0.75, 0.3), "adult_60_plus", 1],
      ["hyperopic reading, child", R(0.6, 0.9), R(0.6, 0.9), "child_3_7", 1],
      ["anisometropia", R(-4, 0.45), R(-0.8, 0.45), "adult_18_39", 1],
      [
        "dead zone, child",
        ...([{ kind: "interval", loD: -2.33, hiD: 0.33, sdD: 0.85 }] as const).flatMap((r) => [r, r]),
        "child_3_7",
        1,
      ] as [string, EyeReading, EyeReading, AgeGroup, number],
      ["one eye", R(-3, 0.45), NONE, "adult_18_39", 1],
      ["other eye", NONE, R(-0.75, 0.45), "teen", 1],
      ["farther light", R(-0.67, 0.45), R(-0.67, 0.45), "adult_40_59", 1.5],
    ];
    const posteriors = readings.map(([name, od, os, ageGroup, distanceM]) => ({
      name,
      ageGroup,
      distanceM,
      readings: { OD: od, OS: os },
      posterior: post(od, os, ageGroup, distanceM),
    }));
    const reports = (
      [
        [-3, -3, "adult_18_39"],
        [-0.9, -0.9, "adult_18_39"],
        [-0.3, -0.3, "child_3_7"],
        [-4, -0.8, "adult_18_39"],
        [-0.75, -0.75, "adult_60_plus"],
        [null, null, "adult_18_39"],
        [null, null, "child_8_12"],
        [1.5, 1.5, "adult_18_39"],
        [-0.9, -0.9, "adult_18_39", false],
      ] as [number | null, number | null, AgeGroup, boolean?][]
    ).map(([od, os, ageGroup, focusModel]) => {
      const r = report(od, os, ageGroup, focusModel);
      // what the twins must agree on, leaving out the Monte Carlo draws each samples its own way
      const eye = (e: (typeof r.eyes)["OD"]) => ({
        outputLevel: e.outputLevel,
        message: e.message,
        seD: e.seD,
        seCi95: e.seCi95,
        refractiveClass: e.refractiveClass,
        confidence: e.confidence,
        classProbabilities: e.classProbabilities,
        refractionRange95: e.refractionRange95 ?? null,
        focusLimited: e.focusLimited ?? false,
        powerVector: e.powerVector,
        notes: e.notes,
      });
      return {
        powers: { OD: od, OS: os },
        ageGroup,
        focusModel: focusModel ?? null,
        eyes: { OD: eye(r.eyes.OD), OS: eye(r.eyes.OS) },
        focus: r.focus,
        interpretation: r.interpretation,
      };
    });
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(
      resolve(FIXTURES, "focus_cases.sample.json"),
      JSON.stringify(snake({ simulated: true, posteriors, reports }), null, 1),
    );
    expect(posteriors.every((p) => p.posterior !== null)).toBe(true);
  });
});
