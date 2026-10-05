import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { frame } from "@/lib/__tests__/fixtures";
import { buildReport, DEFAULT_GATING } from "@/lib/inference/fusion";
import type { StoredAssessment } from "@/lib/types";
import { ReferralReport } from "../ReferralReport";

/** Both eyes with 2 D of astigmatism across four device angles: enough for CYL/AXIS when enabled. */
function assessment({
  simulated,
  cylEnabled,
}: {
  simulated: boolean;
  cylEnabled: boolean;
}): StoredAssessment {
  const powers = [-1, -2, -3, -2];
  const frames = (["OD", "OS"] as const).flatMap((eye) =>
    [0, 45, 90, 135].flatMap((rot, i) =>
      Array.from({ length: 5 }, () => frame(eye, rot, powers[i]!, "excellent", simulated)),
    ),
  );
  const report = buildReport({
    frames,
    ageGroup: "adult_40_59",
    deviceId: "simulated-phone",
    calibrationVersion: "c",
    estimator: { name: "t", version: "0", kind: "test" },
    extractorVersion: "x",
    gating: { ...DEFAULT_GATING, astigmatismQuantificationEnabled: cylEnabled },
  });
  return {
    id: "a1",
    createdAt: "2026-10-05T09:00:00Z",
    profile: {
      label: "P-014",
      ageGroup: "adult_40_59",
      wearsCorrection: "glasses",
      symptoms: false,
      consentImages: false,
    },
    report,
    frames: [],
    visionTests: [],
  };
}

const textOf = (a: StoredAssessment) =>
  renderToStaticMarkup(<ReferralReport a={a} />)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("referral report", () => {
  it("never prints SPH/CYL/AXIS, even when the research flag quantified them", () => {
    const a = assessment({ simulated: true, cylEnabled: true });
    expect(a.report.eyes.OD.astigmatismStatus).toBe("quantified");
    expect(a.report.eyes.OD.cylD).not.toBeNull();
    const text = textOf(a);
    expect(text).not.toMatch(/\b(SPH|CYL|AXIS)\s*[+−-]?\d/);
    expect(text).toContain("Research estimate withheld");
  });

  it("shows the gated spherical equivalent with its interval", () => {
    const a = assessment({ simulated: true, cylEnabled: false });
    expect(a.report.eyes.OD.outputLevel).toBe("quantitative");
    const text = textOf(a);
    expect(text).toMatch(/SE −2\.\d\d D/);
    expect(text).toMatch(/95% interval −\d\.\d\d D to −\d\.\d\d D/);
    expect(text).toContain("P-014");
  });

  it("keeps the disclaimers and marks simulated data on paper", () => {
    const sim = assessment({ simulated: true, cylEnabled: false });
    const text = textOf(sim);
    expect(text).toContain("Not a prescription");
    expect(text).toContain("Not a medical device");
    expect(text).toContain("SIMULATED DATA: a virtual eye, not a real person");
    expect(text).toContain(sim.report.disclaimer);
    expect(textOf(assessment({ simulated: false, cylEnabled: false }))).not.toContain("SIMULATED");
  });
});
