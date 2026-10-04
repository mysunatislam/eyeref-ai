import { describe, expect, it } from "vitest";
import {
  axisToDoubledUnit,
  circularAxisError,
  displayAxis,
  doubledUnitToAxis,
  formatAxis,
  fromPowerVector,
  imageVectorToTabo,
  mirrorAxisHorizontal,
  mirrorPowerVector,
  normalizeAxis,
  rxPowerInMeridian,
  powerInMeridian,
  sphericalEquivalent,
  toPowerVector,
  transpose,
} from "../optics/powerVector";
import { fitPowerVector, posteriorPowerVector, sampleRefraction } from "../optics/meridional";
import { crescentWidthM, deadZoneInterval, invertCrescent } from "../optics/photorefraction";
import {
  anisometropiaProbability,
  classProbabilities,
  normalCdf,
  thresholdsForAge,
} from "../optics/classification";

describe("axis angles", () => {
  it("treats 179° and 1° as 2° apart, not 178°", () => {
    expect(circularAxisError(179, 1)).toBeCloseTo(2);
    expect(circularAxisError(1, 179)).toBeCloseTo(2);
  });
  it("wraps correctly", () => {
    expect(circularAxisError(0, 180)).toBeCloseTo(0);
    expect(circularAxisError(170, 10)).toBeCloseTo(20);
    expect(normalizeAxis(-10)).toBeCloseTo(170);
    expect(normalizeAxis(180)).toBe(0);
  });
  it("formats prescription axes", () => {
    expect(displayAxis(0)).toBe(180);
    expect(formatAxis(8)).toBe("008°");
    expect(formatAxis(null)).toBe("---");
  });
  it("doubled-angle encoding is continuous across 0/180", () => {
    const [c1, s1] = axisToDoubledUnit(179);
    const [c2, s2] = axisToDoubledUnit(1);
    expect(Math.hypot(c1 - c2, s1 - s2)).toBeLessThan(0.08);
    for (const a of [0, 1, 45, 90, 135, 179.9])
      expect(circularAxisError(doubledUnitToAxis(...axisToDoubledUnit(a)), a)).toBeLessThan(1e-9);
  });
  it("mirrors and converts image vectors", () => {
    expect(mirrorAxisHorizontal(30)).toBeCloseTo(150);
    expect(imageVectorToTabo(0, -1)).toBeCloseTo(90);
    expect(imageVectorToTabo(-1, 0)).toBeCloseTo(180);
  });
});

describe("power vectors (J0/J45)", () => {
  const cases = [
    { sph: -2.25, cyl: -0.75, axis: 172 },
    { sph: -1.5, cyl: -0.5, axis: 8 },
    { sph: 3, cyl: -2, axis: 90 },
    { sph: 0, cyl: -1, axis: 45 },
  ];
  it.each(cases)("round-trips %o", (rx) => {
    const back = fromPowerVector(toPowerVector(rx));
    expect(back.sph).toBeCloseTo(rx.sph);
    expect(back.cyl).toBeCloseTo(rx.cyl);
    expect(circularAxisError(back.axis!, rx.axis)).toBeLessThan(1e-6);
  });
  it("matches textbook values", () => {
    const pv = toPowerVector({ sph: -2, cyl: -1, axis: 180 });
    expect(pv.M).toBeCloseTo(-2.5);
    expect(pv.J0).toBeCloseTo(0.5);
    expect(toPowerVector({ sph: 0, cyl: -1, axis: 45 }).J45).toBeCloseTo(0.5);
    expect(sphericalEquivalent({ sph: -2.25, cyl: -0.75, axis: 172 })).toBeCloseTo(-2.625);
  });
  it("transposition preserves the power vector", () => {
    const rx = { sph: -2, cyl: -1, axis: 30 };
    const a = toPowerVector(rx);
    const b = toPowerVector(transpose(rx));
    expect([b.M, b.J0, b.J45]).toEqual([a.M, a.J0, a.J45].map((v) => expect.closeTo(v, 9)));
  });
  it("meridional power agrees between representations", () => {
    const rx = { sph: -1, cyl: -2, axis: 30 };
    for (let t = 0; t < 180; t += 15)
      expect(rxPowerInMeridian(rx, t)).toBeCloseTo(powerInMeridian(toPowerVector(rx), t));
  });
  it("horizontal mirror maps J45 -> -J45 and axis -> 180-axis", () => {
    const rx = { sph: -1, cyl: -1.5, axis: 20 };
    const m = fromPowerVector(mirrorPowerVector(toPowerVector(rx)));
    expect(circularAxisError(m.axis!, 160)).toBeLessThan(1e-6);
  });
});

describe("SPH/CYL/AXIS reconstruction from meridians", () => {
  it("recovers astigmatism from four meridians", () => {
    const truth = { sph: -2.25, cyl: -0.75, axis: 172 };
    const post = fitPowerVector(
      [0, 45, 90, 135].map((m) => ({ meridianDeg: m, powerD: rxPowerInMeridian(truth, m), sigmaD: 0.05 })),
      4,
      10,
    );
    const rx = fromPowerVector(posteriorPowerVector(post));
    expect(rx.sph).toBeCloseTo(-2.25, 1);
    expect(rx.cyl).toBeCloseTo(-0.75, 1);
    expect(circularAxisError(rx.axis!, 172)).toBeLessThan(2);
  });
  it("produces intervals that cover the truth", () => {
    const truth = { sph: -1, cyl: -1.5, axis: 30 };
    const post = fitPowerVector(
      [0, 45, 90, 135].map((m) => ({ meridianDeg: m, powerD: rxPowerInMeridian(truth, m), sigmaD: 0.25 })),
    );
    const d = sampleRefraction(post);
    expect(d.seCi95[0]).toBeLessThan(-1.75);
    expect(d.seCi95[1]).toBeGreaterThan(-1.75);
  });
});

describe("photorefraction model", () => {
  const g = { workingDistanceM: 1, eccentricityM: 0.008, pupilDiameterM: 0.006 };
  it("has the expected dead zone", () => {
    const [lo, hi] = deadZoneInterval(g);
    expect(lo).toBeCloseTo(-1 - 4 / 3);
    expect(hi).toBeCloseTo(-1 + 4 / 3);
    expect(crescentWidthM(-1, g).widthM).toBe(0);
  });
  it.each([-6, -4, -3, 1, 2, 4])("inverts crescent width for %d D", (R) => {
    const { widthM, side } = crescentWidthM(R, g);
    expect(invertCrescent(widthM, side, g)).toBeCloseTo(R);
  });
  it("flips crescent side between myopic and hyperopic defocus", () => {
    expect(crescentWidthM(-4, g).side).toBe(-crescentWidthM(2, g).side);
  });
});

describe("classification", () => {
  it("normal CDF is accurate", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it("probabilities sum to 1", () => {
    const p = classProbabilities(-1, 0.4, thresholdsForAge("adult_18_39"));
    expect(p.myopia + p.emmetropia + p.hyperopia).toBeCloseTo(1);
  });
  it("anisometropia probability responds to inter-eye difference", () => {
    expect(anisometropiaProbability(-1, 0.2, -1, 0.2, 1)).toBeLessThan(0.01);
    expect(anisometropiaProbability(-3.5, 0.2, -1, 0.2, 1)).toBeGreaterThan(0.99);
  });
});
