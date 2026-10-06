import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EXTRACTOR_VERSION } from "../cv/features";
import { PhysicsHeuristicEstimator } from "../inference/estimators";
import { buildReport } from "../inference/fusion";
import { processFrame } from "../inference/pipeline";
import { snake } from "../api";
import {
  analyseStage1,
  DEFAULT_VERTEX_MM,
  describeFocus,
  inducedChangeD,
  isStage1,
  lensOrder,
  lensRole,
  readStage1File,
  stage1Capture,
  stage1Data,
  stage1File,
  Stage1FileError,
  stage1FromParams,
  stage1Link,
  stage1Subject,
  STAGE1_CRITERIA,
  STAGE1_LENSES,
  t975,
  type Stage1Capture,
  type Stage1Data,
} from "../research/stage1";
import { SIM_DEVICE, simulatedScreenAngle, simulateFrame } from "../simulation/session";
import type { EyeSide, FrameRecord, InducedDefocus, OutputLevel, StoredAssessment } from "../types";

const FIXTURE_TIME = new Date("2026-01-01T00:00:00.000Z");
const FIXTURES = resolve(__dirname, "../../../../../shared/fixtures");

const eye = (v: number | null) =>
  v === null
    ? { outputLevel: "repeat" as OutputLevel, seD: null, posteriorM: null, nFrames: 6, nUsableFrames: 2 }
    : { outputLevel: "quantitative" as OutputLevel, seD: v, posteriorM: v, nFrames: 6, nUsableFrames: 6 };

/** A capture with the values already in hand, so the analysis can be checked on its own. */
const cap = (code: string, lensD: number, od: number | null, os: number | null, i = 0): Stage1Capture => ({
  assessmentId: `${code}-${lensD}-${i}`,
  createdAt: `2026-02-0${1 + i}T00:00:00.000Z`,
  code,
  lensD,
  vertexMm: 0,
  correctionInFrameD: 0,
  workingDistanceM: 1,
  device: "sim",
  eyes: { OD: eye(od), OS: eye(os) } as Record<EyeSide, ReturnType<typeof eye>>,
});

const data = (captures: Stage1Capture[], lensesD = [0, 2, 2.5, 3.5]): Stage1Data => ({
  kind: "eyeref-stage1",
  version: 1,
  simulated: true,
  createdAt: FIXTURE_TIME.toISOString(),
  lensesD,
  captures,
});

/** The hand-worked set: three people, eyes with different numbers of values, one eye left out. */
const WORKED = data([
  cap("A", 2, -1.8, -2.1),
  cap("A", 2.5, -2.6, -2.4),
  cap("A", 3.5, -3.3, -3.6),
  cap("B", 2, -1.7, -2.0),
  cap("B", 2.5, -2.3, -2.7),
  cap("B", 3.5, -3.5, null),
  cap("C", 2, -2.2, null),
  cap("C", 3.5, -3.8, null),
  cap("A", 0, -0.9, -1.0, 0),
  cap("A", 0, null, -1.2, 1),
  cap("B", 0, -0.4, null),
  cap("C", 0, null, -0.5),
]);

describe("a trial lens over a correction", () => {
  it("changes the eye by the lens's power at the eye", () => {
    // a +2 D lens 12 mm in front of an eye acts as a little more than 2 D there
    expect(inducedChangeD({ lensD: 2, vertexMm: 12, correctionInFrameD: 0 })).toBeCloseTo(
      -2 / (1 - 0.024),
      9,
    );
    expect(inducedChangeD({ lensD: 2, vertexMm: 0, correctionInFrameD: 0 })).toBe(-2);
    // contact lenses leave the added lens alone; glasses in the same frame change what it does
    const inFrame = inducedChangeD({ lensD: 2, vertexMm: 12, correctionInFrameD: -4 });
    expect(inFrame).not.toBeCloseTo(-2 / (1 - 0.024), 3);
    expect(inFrame).toBeGreaterThan(-2);
  });

  it("fogs the eye only once the light is beyond its far point", () => {
    const at = (lensD: number, workingDistanceM = 1) =>
      lensRole({ lensD, vertexMm: DEFAULT_VERTEX_MM, correctionInFrameD: 0, workingDistanceM });
    expect(at(0)).toBe("check");
    expect(at(1)).toBe("in_reach");
    expect(at(1.5)).toBe("fogging");
    expect(at(-2)).toBe("in_reach");
    // a light further away needs less plus to pass the far point
    expect(at(1.25)).toBe("in_reach");
    expect(at(1.25, 1.5)).toBe("fogging");
    // the protocol's series: the no-lens check and five fogging lenses at 1 m
    expect(STAGE1_LENSES.map((l) => at(l))).toEqual([
      "check",
      "fogging",
      "fogging",
      "fogging",
      "fogging",
      "fogging",
    ]);
  });

  it("gives each participant a fixed order of the same lenses", () => {
    const a = lensOrder("S1-01");
    expect([...a].sort((x, y) => x - y)).toEqual([...STAGE1_LENSES].sort((x, y) => x - y));
    expect(lensOrder("S1-01")).toEqual(a);
    expect(lensOrder("S1-02")).not.toEqual(a);
  });
});

describe("Student's t at 97.5%", () => {
  it("matches scipy's values", () => {
    expect(t975(1)).toBeCloseTo(12.706204736, 9);
    expect(t975(2)).toBeCloseTo(4.30265273, 9);
    expect(t975(9)).toBeCloseTo(2.262157163, 9);
    expect(t975(30)).toBeCloseTo(2.042272456, 9);
    // beyond the table, the expansion is still good to a few parts in a million
    expect(t975(31)).toBeCloseTo(2.039513446, 5);
    expect(t975(60)).toBeCloseTo(2.000297822, 5);
    expect(t975(1000)).toBeCloseTo(1.962339081, 5);
  });
});

describe("the stage 1 analysis", () => {
  const report = analyseStage1(WORKED);

  it("fits one slope with each eye's own baseline", () => {
    // against an independent dummy-variable regression in Python (numpy lstsq + a CR1 cluster-robust SE)
    expect(report.fit!.slope).toBeCloseTo(1.0719298245614026, 9);
    expect(report.fit!.slopeCi95![0]).toBeCloseTo(0.7777029551353469, 6);
    expect(report.fit!.slopeCi95![1]).toBeCloseTo(1.3661566939874583, 6);
    expect(report.fit!.intercept).toBeCloseTo(0.12770467836257288, 9);
    expect(report.fit!.interceptCi95![0]).toBeCloseTo(-0.2597612180491445, 6);
    expect(report.fit!.withinSdD).toBeCloseTo(0.13823236645049136, 9);
    expect(report.fit!.repeatabilityD).toBeCloseTo(0.3831605712906965, 9);
    expect(report.fit!.icc).toBeCloseTo(0.5379812809174949, 9);
    // the eye with one value cannot have a line of its own, so it is left out
    expect([report.fit!.people, report.fit!.eyes, report.fit!.n]).toEqual([3, 5, 13]);
  });

  it("counts people as the independent unit, not eyes", () => {
    // two eyes of one person carry one vote: the interval does not shrink when the second eye is identical
    const one = data([
      cap("A", 2, -1.8, null),
      cap("A", 3, -2.8, null),
      cap("B", 2, -2.0, null),
      cap("B", 3, -3.1, null),
    ]);
    const both = data([
      cap("A", 2, -1.8, -1.8),
      cap("A", 3, -2.8, -2.8),
      cap("B", 2, -2.0, -2.0),
      cap("B", 3, -3.1, -3.1),
    ]);
    const w = (d: Stage1Data) => analyseStage1(d).fit!;
    expect(w(both).slope).toBeCloseTo(w(one).slope, 9);
    const width = (f: ReturnType<typeof w>) => f.slopeCi95![1] - f.slopeCi95![0];
    expect(width(w(both))).toBeCloseTo(width(w(one)), 9);
  });

  it("measures how far the eyes focused on the light, from the no-lens captures", () => {
    const f = report.focus!;
    expect(f.shiftD).toBeCloseTo(-0.9918128654970761, 9);
    expect(f.ci95![0]).toBeCloseTo(-3.956593970604506, 6);
    // the eye with no line of its own is left out of this too
    expect([f.people, f.eyes]).toEqual([2, 3]);
    expect(describeFocus({ ...f, shiftD: -0.9, ci95: [-1.1, -0.7] })).toContain("0.90 D more myopic");
    expect(describeFocus({ ...f, shiftD: -0.05, ci95: [-0.3, 0.2] })).toContain("too close to zero");
    expect(describeFocus({ ...f, shiftD: 0.8, ci95: [0.5, 1.1] })).toContain("focusing cannot explain");
  });

  it("counts every eye-capture's quality, lens by lens", () => {
    expect(report.quality).toMatchObject({ eyeCaptures: 24, passed: 18, released: 18, passedShare: 0.75 });
    const l2 = report.lenses.find((r) => r.lensD === 2)!;
    expect(l2).toMatchObject({ captures: 3, released: 5, eyeCaptures: 6, inducedD: -2 });
    expect(l2.roles).toMatchObject({ fogging: 3, check: 0, in_reach: 0 });
    expect(report.lenses.find((r) => r.lensD === 0)!.roles.check).toBe(4);
    // a lens of the series no one has captured yet still has a row, with the change it would make
    const empty = analyseStage1(data([cap("A", 2, -2, -2)], [2, 3]));
    expect(empty.lenses.find((r) => r.lensD === 3)).toMatchObject({ captures: 0, released: 0 });
  });

  it("waits for ten people before it says go or no go", () => {
    expect(report.verdict).toBe("incomplete");
    expect(report.criteria.find((c) => c.id === "people")!.pass).toBe(false);
    const many = data(
      Array.from({ length: STAGE1_CRITERIA.minPeople }, (_, i) =>
        [0, 2, 2.5, 3.5].map((l) => cap(`P${i}`, l, -(l === 0 ? 0.8 : l), -(l === 0 ? 0.8 : l))),
      ).flat(),
    );
    const go = analyseStage1(many);
    expect(go.complete).toBe(STAGE1_CRITERIA.minPeople);
    expect(go.criteria.every((c) => c.pass)).toBe(true);
    expect(go.verdict).toBe("go");
    // a slope outside 0.8–1.2 is a no go, with every person counted
    const flat = data(
      Array.from({ length: STAGE1_CRITERIA.minPeople }, (_, i) =>
        [0, 2, 2.5, 3.5].map((l) => cap(`P${i}`, l, -0.5 * l, -0.5 * l)),
      ).flat(),
    );
    const no = analyseStage1(flat);
    expect(no.fit!.slope).toBeCloseTo(0.5, 9);
    expect(no.verdict).toBe("no_go");
    expect(no.criteria.find((c) => c.id === "slope")!.pass).toBe(false);
  });

  it("says what is missing instead of inventing a slope", () => {
    const none = analyseStage1(data([cap("A", 2, null, null)]));
    expect(none.fit).toBeNull();
    expect(none.focus).toBeNull();
    expect(none.verdict).toBe("incomplete");
    expect(none.criteria.find((c) => c.id === "slope")!.detail).toContain("No eye has a number");
    expect(none.criteria.find((c) => c.id === "quality")!.pass).toBe(false);
  });
});

describe("the stage 1 file", () => {
  it("keeps the lens with the values, and no image", () => {
    const d = data([cap("A", 2, -1.9, -2.1)]);
    const text = stage1File(d);
    expect(text).not.toContain("data:image");
    const back = readStage1File(text);
    expect(back).toEqual(d);
    expect(JSON.parse(text).captures[0].lens_d).toBe(2);
  });

  it("refuses a file that is not stage 1 data", () => {
    expect(() => readStage1File("not json")).toThrow(Stage1FileError);
    expect(() => readStage1File(JSON.stringify({ kind: "eyeref-bench-run", version: 1 }))).toThrow(
      /not an EyeRef stage 1 file/,
    );
    expect(() => readStage1File(JSON.stringify({ kind: "eyeref-stage1", version: 2 }))).toThrow(
      /version 2 stage 1 file/,
    );
    const text = stage1File(data([cap("A", 2, -1.9, -2.1)]));
    const broken = (patch: (capture: Record<string, unknown>) => void) => {
      const copy = JSON.parse(text) as { captures: Record<string, unknown>[] };
      patch(copy.captures[0]!);
      return () => readStage1File(JSON.stringify(copy));
    };
    expect(broken((c) => delete c.lens_d)).toThrow(/incomplete/);
    expect(broken((c) => (c.code = ""))).toThrow(/incomplete/);
    expect(broken((c) => (c.working_distance_m = 0))).toThrow(/incomplete/);
    expect(broken((c) => ((c.eyes as { OD: Record<string, unknown> }).OD.output_level = "guess"))).toThrow(
      /incomplete/,
    );
  });

  it("takes only the captures of the mode it is in, oldest first", () => {
    const base: StoredAssessment = {
      id: "x",
      createdAt: "2026-03-02T00:00:00.000Z",
      profile: {
        label: "A",
        ageGroup: "adult_18_39",
        wearsCorrection: "contacts",
        symptoms: false,
        consentImages: false,
      },
      report: {
        ...({} as StoredAssessment["report"]),
        simulated: true,
        eyes: { OD: eye(-2) as never, OS: eye(-2) as never },
        provenance: { deviceProfile: "sim" } as StoredAssessment["report"]["provenance"],
      },
      frames: [],
      visionTests: [],
      induced: { code: "A", lensD: 2, vertexMm: 12, correctionInFrameD: 0, workingDistanceM: 1 },
    };
    const older = { ...base, id: "w", createdAt: "2026-03-01T00:00:00.000Z" };
    const real = { ...base, id: "r", report: { ...base.report, simulated: false } };
    const plain = { ...base, id: "p", induced: undefined };
    const items = [base, older, real, plain];
    expect(stage1Data(items, true, FIXTURE_TIME).captures.map((c) => c.assessmentId)).toEqual(["w", "x"]);
    expect(stage1Data(items, false, FIXTURE_TIME).captures.map((c) => c.assessmentId)).toEqual(["r"]);
    // a damaged lens record is not analysed, but it is still known to be a lens capture
    const damaged = { ...base, id: "d", induced: { code: "A" } as InducedDefocus };
    expect(isStage1(damaged)).toBe(false);
    expect(stage1Data([damaged], true).captures).toHaveLength(0);
    expect(isStage1(base) && stage1Capture(base).eyes.OD.seD).toBe(-2);
  });
});

describe("a capture link", () => {
  const read = (url: string, d = 1) => {
    const q = new URL(url, "https://e.test").searchParams;
    return stage1FromParams((k) => q.get(k), d);
  };

  it("carries the lens and the frame, and nothing else decides them", () => {
    const lens: InducedDefocus = {
      code: "S1-01",
      lensD: 2.5,
      vertexMm: 12,
      correctionInFrameD: -3.25,
      workingDistanceM: 1,
    };
    expect(read(stage1Link(lens))).toEqual(lens);
    expect(read("/assess")).toBeNull();
    expect(read("/assess?stage1=2")).toBeNull();
    expect(read("/assess?stage1=2&code=S1 01")).toBeNull();
    expect(read("/assess?stage1=lots&code=S1-01")).toBeNull();
    expect(read("/assess?stage1=2&code=S1-01&vertex=99")).toBeNull();
    // the working distance comes from the app's own setting, never from the link
    expect(read("/assess?stage1=2&code=S1-01", 1.5)).toMatchObject({ workingDistanceM: 1.5, vertexMm: 12 });
  });
});

describe("a simulated stage 1 series", () => {
  const est = new PhysicsHeuristicEstimator();
  const codes = ["S1-01", "S1-02", "S1-03"];
  let report: ReturnType<typeof analyseStage1>;
  let d: Stage1Data;

  beforeAll(() => {
    const items: StoredAssessment[] = [];
    for (const code of codes)
      for (const lensD of STAGE1_LENSES) {
        const induced: InducedDefocus = {
          code,
          lensD,
          vertexMm: DEFAULT_VERTEX_MM,
          correctionInFrameD: 0,
          workingDistanceM: 1,
        };
        const subject = stage1Subject(induced);
        const frames: FrameRecord[] = [];
        for (const rot of [0, 90])
          for (let i = 0; i < 3; i++)
            for (const e of ["OD", "OS"] as const) {
              const sf = simulateFrame(subject, e, rot, rot * 10 + i, 11, {
                blinkRate: 0,
                motionRate: 0,
                frameRotationDeg: simulatedScreenAngle(rot),
              });
              frames.push({
                ...processFrame(sf.image, sf.iris, sf.metadata, SIM_DEVICE, est).record,
                protocolRotationDeg: rot,
              });
            }
        const built = buildReport({
          frames,
          ageGroup: "adult_18_39",
          deviceId: SIM_DEVICE.id,
          calibrationVersion: SIM_DEVICE.calibrationVersion,
          estimator: { name: est.name, version: est.version, kind: est.kind },
          extractorVersion: EXTRACTOR_VERSION,
          id: `${code}-${lensD}`,
        });
        items.push({
          id: built.id,
          createdAt: `2026-04-01T00:00:${String(items.length).padStart(2, "0")}.000Z`,
          profile: {
            label: code,
            ageGroup: "adult_18_39",
            wearsCorrection: "contacts",
            symptoms: false,
            consentImages: false,
            datasetCode: code,
          },
          report: built,
          frames,
          visionTests: [],
          induced,
        });
      }
    d = stage1Data(items, true, FIXTURE_TIME);
    report = analyseStage1(d);
  }, 120_000);

  it("measures the change each lens makes, through the real pipeline", () => {
    const [lo, hi] = STAGE1_CRITERIA.slope;
    expect(report.fit!.slope).toBeGreaterThanOrEqual(lo);
    expect(report.fit!.slope).toBeLessThanOrEqual(hi);
    expect(report.fit!.slopeCi95![0]).toBeGreaterThan(0.8);
    expect(report.fit!.withinSdD).toBeLessThanOrEqual(STAGE1_CRITERIA.maxWithinSdD);
    expect(report.fit!.people).toBe(codes.length);
    expect(report.criteria.filter((c) => c.id !== "people").every((c) => c.pass)).toBe(true);
    // not enough people for a verdict, however good the numbers are
    expect(report.verdict).toBe("incomplete");
  });

  it("sees the eyes focus on the light when no lens stops them", () => {
    // the virtual adults follow most of the light's pull, so the no-lens capture reads myopic
    expect(report.focus!.shiftD).toBeLessThan(-0.4);
    expect(report.focus!.ci95![1]).toBeLessThan(0);
    expect(describeFocus(report.focus!)).toContain("more myopic");
  });

  it("writes the fixtures the backend reads", () => {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(resolve(FIXTURES, "stage1_data.sample.json"), stage1File(d));
    writeFileSync(resolve(FIXTURES, "stage1_report.sample.json"), JSON.stringify(snake(report), null, 1));
    expect(d.captures.length).toBe(codes.length * STAGE1_LENSES.length);
  });
});
