import { describe, expect, it } from "vitest";
import { truthRx } from "@/components/results/SimTruthCard";
import { formatDiopters } from "../optics/powerVector";
import { formatDate, formatDateTime, probability } from "../utils";

describe("probabilities about one person", () => {
  it("never round to certainty", () => {
    expect(probability(1)).toBe("> 99%");
    expect(probability(0.996)).toBe("> 99%");
    expect(probability(0.99)).toBe("99%");
    expect(probability(0.5)).toBe("50%");
    expect(probability(0.01)).toBe("1%");
    expect(probability(0.004)).toBe("< 1%");
    expect(probability(0)).toBe("< 1%");
  });

  it("show a dash when there is no value", () => {
    expect(probability(null)).toBe("—");
    expect(probability(undefined)).toBe("—");
    expect(probability(Number.NaN)).toBe("—");
  });
});

describe("dates", () => {
  // noon UTC is the same calendar day in nearly every time zone
  const when = "2026-10-05T12:00:00.000Z";

  it("follow the interface language, whatever the browser's", () => {
    expect(formatDate(when)).toBe("Oct 5, 2026");
    expect(formatDateTime(when)).toMatch(/^Oct 5, 2026, \d{1,2}:\d{2}\s?[AP]M$/);
  });
});

describe("simulator truth", () => {
  it("reads as a sphere when there is no cylinder", () => {
    expect(truthRx({ sph: -3, cyl: 0, axis: null, se: -3 })).toBe("−3.00 D sphere");
    expect(truthRx({ sph: -1, cyl: -1.5, axis: 180, se: -1.75 })).toBe("−1.00 D / −1.50 D × 180°");
  });
});

describe("dioptres", () => {
  it("carry a sign, except a value that rounds to zero", () => {
    expect(formatDiopters(-0.003)).toBe("0.00 D");
    expect(formatDiopters(0.004)).toBe("0.00 D");
    expect(formatDiopters(-0)).toBe("0.00 D");
    expect(formatDiopters(-0.005)).toBe("−0.01 D");
    expect(formatDiopters(1.25)).toBe("+1.25 D");
    expect(formatDiopters(-1.62)).toBe("−1.62 D");
  });
});
