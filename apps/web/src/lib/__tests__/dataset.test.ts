import { describe, expect, it } from "vitest";
import { bestGt } from "../dataset";
import type { GroundTruthEntry, StoredAssessment } from "../types";

const gt = (o: Partial<GroundTruthEntry> = {}): GroundTruthEntry => ({
  eye: "OD",
  method: "autorefractor",
  sphere: -1,
  cylinder: 0,
  axis: null,
  ...o,
});
const record = (groundTruth: GroundTruthEntry[]) => ({ groundTruth }) as StoredAssessment;

describe("the reference refraction of a record", () => {
  it("is the best method taken for that eye", () => {
    const a = record([
      gt(),
      gt({ method: "subjective", sphere: -1.25 }),
      gt({ eye: "OS", method: "cycloplegic", sphere: -2 }),
    ]);
    expect(bestGt(a, "OD")).toMatchObject({ method: "subjective", sphere: -1.25 });
    expect(bestGt(a, "OS")).toMatchObject({ method: "cycloplegic", sphere: -2 });
  });

  it("is the latest entry of a method measured twice, as on the research server", () => {
    expect(bestGt(record([gt({ sphere: -1 }), gt({ sphere: -1.5 })]), "OD")?.sphere).toBe(-1.5);
  });

  it("is in minus-cylinder form whatever form was entered", () => {
    expect(bestGt(record([gt({ sphere: -2, cylinder: 1, axis: 45 })]), "OD")).toMatchObject({
      sphere: -1,
      cylinder: -1,
      axis: 135,
    });
  });

  it("is missing when none was taken for that eye", () => {
    expect(bestGt(record([gt({ eye: "OS" })]), "OD")).toBeNull();
  });
});
