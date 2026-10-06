/**
 * Bench calibration: the stage 0 analysis on SIMULATED bench runs. A run whose profile matches the
 * phone must pass every check, and each mistake an operator can make must fail the checks meant to
 * catch it. The run and its report are written to shared/fixtures for the Python twin's test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { snake } from "../api";
import {
  analyseBench,
  calibratedProfile,
  fitGradientGain,
  icc11,
  withCalibratedDevice,
  type BenchReport,
} from "../bench/analysis";
import {
  benchSteps,
  BenchFileError,
  deadZoneLenses,
  DEFAULT_SETUP,
  inducedRefraction,
  lensForRefraction,
  newRun,
  readRunFile,
  runFile,
  runFileName,
  SIM_MISTAKES,
  simulateStep,
  steps as lensSteps,
  withStep,
  type BenchRun,
  type BenchSetup,
  type SimMistake,
} from "../bench/run";
import { SIM_DEVICE } from "../simulation/session";

const FIXTURE_TIME = new Date("2026-01-01T00:00:00.000Z");
const FIXTURES = resolve(__dirname, "../../../../../shared/fixtures");
const pin = (k: string, v: unknown) => (k === "timestamp" ? FIXTURE_TIME.toISOString() : v);

function simulatedRun(setup: BenchSetup, mistake: SimMistake = "none"): BenchRun {
  let run = newRun(SIM_DEVICE, setup, true, FIXTURE_TIME);
  for (const step of benchSteps(setup))
    run = withStep(run, step, simulateStep(run, step, SIM_MISTAKES[mistake].truth));
  return run;
}

const passed = (r: BenchReport) => Object.fromEntries(r.criteria.map((c) => [c.id, c.pass]));

// fewer frames and one rotation are enough to see a mistake fail its checks
const QUICK: BenchSetup = {
  ...DEFAULT_SETUP,
  lensesD: lensSteps(-4, 4, 1),
  rotationsDeg: [0],
  framesPerStep: 2,
};

describe("bench steps", () => {
  it("gives a plus lens a myopic refraction, with the lens's power taken at the eye", () => {
    expect(inducedRefraction(1)).toBe(-1);
    expect(inducedRefraction(-2)).toBe(2);
    expect(inducedRefraction(4, 0, 12)).toBeCloseTo(-4 / (1 - 0.048), 10);
    expect(inducedRefraction(1, 0.5)).toBe(-0.5);
  });

  it("captures every lens at one rotation before turning the phone", () => {
    const s = benchSteps({ ...DEFAULT_SETUP, lensesD: [-1, 0, 1], rotationsDeg: [0, 90] });
    expect(s.map((x) => [x.index, x.lensD, x.rotationDeg])).toEqual([
      [0, -1, 0],
      [1, 0, 0],
      [2, 1, 0],
      [3, -1, 90],
      [4, 0, 90],
      [5, 1, 90],
    ]);
    expect(benchSteps(DEFAULT_SETUP)).toHaveLength(34);
  });

  it("finds the lens for a refraction, the other way round", () => {
    for (const vertexMm of [0, 12])
      for (const lensD of [-4, -1.25, 0, 2.5, 4]) {
        const r = inducedRefraction(lensD, 0.5, vertexMm);
        expect(lensForRefraction(r, { eyeRefractionD: 0.5, vertexMm })).toBeCloseTo(lensD, 10);
      }
  });

  it("lists the lenses across the predicted dead zone, for a finer series", () => {
    // e = 8 mm, d = 1 m, p = 6 mm: the dead zone is −2.33 to +0.33 D, so lenses −0.33 to +2.33 D
    expect(deadZoneLenses(SIM_DEVICE, DEFAULT_SETUP)).toEqual(lensSteps(-0.75, 2.75, 0.25));
    expect(deadZoneLenses({ ...SIM_DEVICE, flashOffsetMm: null }, DEFAULT_SETUP)).toEqual([]);
  });
});

describe("fits", () => {
  it("recovers the gain of a straight line, and down-weights an outlier", () => {
    const x = [-0.2, -0.1, 0, 0.1, 0.2, 0.15, -0.15];
    const y = x.map((v) => -5 * v + 0.1);
    const fit = fitGradientGain(x, y)!;
    expect(fit.gain).toBeCloseTo(5, 9);
    expect(fit.intercept).toBeCloseTo(0.1, 9);
    expect(fit.residualSd).toBeLessThan(1e-9);
    expect(fit.r).toBeCloseTo(-1, 9);
    const robust = fitGradientGain([...x, 0.05], [...y, 3])!;
    expect(Math.abs(robust.gain - 5)).toBeLessThan(0.5);
    expect(robust.n).toBe(8);
  });

  it("needs five frames and slopes that differ", () => {
    expect(fitGradientGain([1, 2, 3, 4], [1, 2, 3, 4])).toBeNull();
    expect(fitGradientGain([1, 1, 1, 1, 1], [1, 2, 3, 4, 5])).toBeNull();
  });

  it("gives ICC(1,1) as the Python does", () => {
    expect(
      icc11([
        [1, 1, 1],
        [2, 2, 2],
        [3, 3, 3],
      ]),
    ).toBe(1);
    expect(
      icc11([
        [1, 2, 3],
        [1, 2, 3],
      ])!,
    ).toBeLessThan(0.1);
    expect(icc11([[1, 2]])).toBeNull();
  });
});

describe("a simulated stage 0 run", () => {
  const run = simulatedRun(DEFAULT_SETUP);
  const report = analyseBench(run);

  it("passes every check when the profile matches the phone", () => {
    expect(run.frames).toHaveLength(170);
    expect(report.criteria.filter((c) => !c.pass)).toEqual([]);
    expect(report.go).toBe(true);
    const [lo, hi] = report.predicted!.deadZoneD;
    expect(lo).toBeCloseTo(-7 / 3, 9);
    expect(hi).toBeCloseTo(1 / 3, 9);
    // half-way between the last step with a crescent and the first without
    expect(report.observedEdgesD).toEqual([-2.25, 0.25]);
    expect(report.widthFit!.slope).toBeGreaterThan(0.85);
    expect(report.icc!).toBeGreaterThan(0.99);
  });

  it("measures the gain the simulated phone's profile was given", () => {
    const g = report.gain!;
    expect(g.levels).toBe(5);
    expect(g.n).toBe(50);
    expect(Math.abs(g.gain / SIM_DEVICE.gradientGain! - 1)).toBeLessThan(0.1);
    expect(Math.abs(g.r)).toBeGreaterThan(0.99);
  });

  it("offers the profile with the measured gain", () => {
    expect(report.calibrated).toEqual(calibratedProfile(SIM_DEVICE, report.gain!, FIXTURE_TIME));
    expect(report.calibrated).toMatchObject({
      id: SIM_DEVICE.id,
      flashOffsetMm: SIM_DEVICE.flashOffsetMm,
      gradientGain: Math.round(report.gain!.gain * 1000) / 1000,
      calibrationVersion: "bench-2026-01-01",
    });
  });

  it("replaces the profile it was measured from, and keeps the others", () => {
    const other = { ...SIM_DEVICE, id: "custom-other", model: "Other phone" };
    const before = [other, { ...SIM_DEVICE, gradientGain: null }];
    const after = withCalibratedDevice(before, report.calibrated!);
    expect(after.map((d) => d.id)).toEqual(["custom-other", SIM_DEVICE.id]);
    expect(after[0]).toBe(other);
    expect(after[1]).toMatchObject({
      gradientGain: report.calibrated!.gradientGain,
      calibrationVersion: "bench-2026-01-01",
    });
    expect(after[1]!.notes).toContain("bench run (bench-2026-01-01)");
    // a profile deleted since the run comes back with the gain
    expect(withCalibratedDevice([other], report.calibrated!).map((d) => d.id)).toEqual([
      "custom-other",
      SIM_DEVICE.id,
    ]);
  });

  it("puts the crescent on the source's side for a myopic lens, and opposite for a hyperopic one", () => {
    const at = (lensD: number) =>
      report.steps.find((s) => s.step.lensD === lensD && s.step.rotationDeg === 0)!;
    expect(at(4)).toMatchObject({ zone: "outside", expectedSide: 1, side: 1, crescentShare: 1 });
    expect(at(-4)).toMatchObject({ zone: "outside", expectedSide: -1, side: -1, crescentShare: 1 });
    expect(at(1)).toMatchObject({ zone: "inside", side: 0, crescentShare: 0 });
    expect(at(1).power!.mean).toBeCloseTo(-1, 0);
  });

  it("saves to a file the app reads back, with the same report", () => {
    const text = runFile(run);
    expect(text).toContain('"refraction_d"');
    expect(runFileName(run)).toBe("eyeref-simulated-bench-simulated-phone-2026-01-01T000000.json");
    const back = readRunFile(text);
    expect(back).toEqual(run);
    expect(analyseBench(back)).toEqual(report);
  });
});

describe("a mistake in the setup fails the checks meant to catch it", () => {
  it("passes the quick series without one", () => {
    expect(analyseBench(simulatedRun(QUICK)).go).toBe(true);
  });

  it("fails the side, width and gain checks with the flash measured on the wrong side", () => {
    const report = analyseBench(simulatedRun(QUICK, "flash-side"));
    expect(passed(report)).toMatchObject({ side: false, width: false, gain: false });
    expect(report.criteria.find((c) => c.id === "side")!.detail).toContain(
      "Every step shows it on the opposite side: check the sign of the measured flash position first.",
    );
    expect(report.widthFit!.slope).toBeLessThan(0);
    expect(report.gain!.gain).toBeLessThan(0);
    expect(report.go).toBe(false);
    expect(report.calibrated).toBeNull();
  });

  it("says so when the frames at one rotation are turned the other way from what the app assumes", () => {
    const setup = { ...QUICK, rotationsDeg: [0, 90] };
    let run = newRun(SIM_DEVICE, setup, true, FIXTURE_TIME);
    // at 90° the light really sits half a turn from where the app puts it
    const turnedBack = { device: { ...SIM_DEVICE, flashOffsetMm: [0, 9.4] as [number, number] } };
    for (const step of benchSteps(setup))
      run = withStep(run, step, simulateStep(run, step, step.rotationDeg === 90 ? turnedBack : {}));
    const side = analyseBench(run).criteria.find((c) => c.id === "side")!;
    expect(side.pass).toBe(false);
    expect(side.detail).toContain(
      "At 90° every step shows it on the opposite side, so the frames at that rotation are not turned the way the app assumes.",
    );
    expect(side.detail).toMatch(/^6 of 12 steps/);
  });

  it("fails the dead-zone and width checks with the model eye nearer than entered", () => {
    const report = analyseBench(simulatedRun(QUICK, "distance"));
    expect(passed(report)).toMatchObject({ edges: false, width: false });
    expect(report.go).toBe(false);
    expect(report.calibrated).toBeNull();
  });

  it("checks nothing for a profile without a light source", () => {
    const run = {
      ...simulatedRun({ ...QUICK, lensesD: [0] }),
      device: { ...SIM_DEVICE, flashOffsetMm: null },
    };
    const report = analyseBench(run);
    expect(report.go).toBe(false);
    expect(report.criteria).toHaveLength(1);
    expect(report.predicted).toBeNull();
  });

  it("is no go while a step has no usable frame", () => {
    const run = simulatedRun(QUICK);
    const report = analyseBench({ ...run, frames: run.frames.filter((f) => f.lensD !== -3) });
    expect(passed(report)).toEqual({
      complete: false,
      side: true,
      width: true,
      edges: true,
      icc: true,
      gain: true,
    });
    expect(report.criteria[0]!.detail).toBe("1 of 9 steps have no usable frame: −3.00 D at 0°.");
    expect(report.go).toBe(false);
    // without the steps past one edge, the side and dead-zone checks have nothing to judge
    const short = analyseBench({ ...run, frames: run.frames.filter((f) => f.lensD > -1) });
    expect(passed(short)).toMatchObject({ complete: false, side: false, edges: false });
  });
});

describe("run files", () => {
  it("refuses a file that is not a bench run", () => {
    expect(() => readRunFile("not json")).toThrow(BenchFileError);
    expect(() => readRunFile(JSON.stringify({ format: "eyeref-assessments/1" }))).toThrow(
      "This is not an EyeRef bench run.",
    );
    expect(() => readRunFile(JSON.stringify({ kind: "eyeref-bench-run", version: 2 }))).toThrow(/version 2/);
    expect(() => readRunFile(JSON.stringify({ kind: "eyeref-bench-run", version: 1 }))).toThrow(/incomplete/);
  });

  it("refuses a run whose setup or frames are broken", () => {
    const text = runFile(simulatedRun(QUICK));
    type Raw = { frames: { record?: unknown }[]; setup: Record<string, unknown> };
    const broken = (change: (r: Raw) => void) => {
      const r = JSON.parse(text) as Raw;
      change(r);
      return () => readRunFile(JSON.stringify(r));
    };
    expect(broken(() => {})).not.toThrow();
    expect(broken((r) => delete r.frames[3]!.record)).toThrow("This bench run is incomplete.");
    expect(broken((r) => (r.setup.lenses_d = []))).toThrow("This bench run is incomplete.");
    expect(broken((r) => (r.setup.working_distance_m = "1"))).toThrow("This bench run is incomplete.");
  });

  it("writes a simulated run and its report for the Python twin's test", () => {
    const run = simulatedRun({ ...QUICK, rotationsDeg: [0, 90] });
    const report = analyseBench(run);
    expect(report.go).toBe(true);
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(resolve(FIXTURES, "bench_run.sample.json"), JSON.stringify(snake(run), pin, 1));
    writeFileSync(resolve(FIXTURES, "bench_report.sample.json"), JSON.stringify(snake(report), null, 1));
  });
});
