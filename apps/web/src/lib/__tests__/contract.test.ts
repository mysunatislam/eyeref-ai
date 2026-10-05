/**
 * Cross-language contract: a report built by the browser pipeline, converted at the API boundary,
 * is written to shared/fixtures so backend/tests/test_contract.py can validate it with pydantic.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUpload, camel, slimReport, snake } from "../api";
import { EXTRACTOR_VERSION } from "../cv/features";
import { PhysicsHeuristicEstimator } from "../inference/estimators";
import { buildReport } from "../inference/fusion";
import { processFrame } from "../inference/pipeline";
import { PROTOCOL_VERSION } from "../protocol/protocol";
import { makeSubject, SIM_DEVICE, simulateFrame } from "../simulation/session";
import type { AssessmentReport, FrameRecord } from "../types";

const FIXTURE_TIME = "2026-01-01T00:00:00.000Z";
const FIXTURES = resolve(__dirname, "../../../../../shared/fixtures");
// fixed timestamps keep the committed fixtures stable from run to run
const pin = (_k: string, v: unknown) => (_k === "timestamp" ? FIXTURE_TIME : v);
// a 1x1 PNG, standing in for an eye crop
const CROP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let simulated: { frames: FrameRecord[]; report: AssessmentReport } | undefined;

/** A simulated assessment run through the browser pipeline, as the app stores it. */
function simulatedAssessment() {
  if (simulated) return simulated;
  const s = makeSubject("CONTRACT-1", "adult_18_39");
  const est = new PhysicsHeuristicEstimator();
  const frames: FrameRecord[] = [];
  for (const rot of [0, 45, 90, 135])
    for (let i = 0; i < 4; i++)
      for (const eye of ["OD", "OS"] as const) {
        const f = simulateFrame(s, eye, rot, rot * 10 + i, 1, { blinkRate: 0, motionRate: 0 });
        frames.push(processFrame(f.image, f.iris, f.metadata, SIM_DEVICE, est).record);
      }
  const report = buildReport({
    frames,
    ageGroup: "adult_18_39",
    deviceId: SIM_DEVICE.id,
    calibrationVersion: SIM_DEVICE.calibrationVersion,
    estimator: { name: est.name, version: est.version, kind: est.kind },
    extractorVersion: EXTRACTOR_VERSION,
    id: "contract-fixture",
  });
  simulated = { frames, report };
  return simulated;
}

describe("API boundary", () => {
  it("keeps upper-case keys and round-trips camel/snake", () => {
    const x = { seCi95: [1, 2], powerVector: { M: 1, J0: 2, J45: 3 }, eyes: { OD: { nUsableFrames: 1 } } };
    expect(snake(x)).toEqual({
      se_ci95: [1, 2],
      power_vector: { M: 1, J0: 2, J45: 3 },
      eyes: { OD: { n_usable_frames: 1 } },
    });
    expect(camel(snake(x))).toEqual(x);
  });

  it("writes a simulated report fixture for the backend contract test", () => {
    const { frames, report: rep } = simulatedAssessment();
    expect(rep.simulated).toBe(true);
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(
      resolve(FIXTURES, "web_report.sample.json"),
      JSON.stringify(snake(slimReport(rep)), pin, 1),
    );
    writeFileSync(resolve(FIXTURES, "web_frame.sample.json"), JSON.stringify(snake(frames[0]), pin, 1));
  });

  it("writes a research upload fixture, built the way the dataset page builds it", () => {
    const { frames, report } = simulatedAssessment();
    const upload = buildUpload(
      {
        id: "contract-record",
        createdAt: FIXTURE_TIME,
        profile: {
          label: "on this device only",
          ageGroup: "adult_18_39",
          wearsCorrection: "none",
          symptoms: false,
          consentImages: true,
          datasetCode: "CONTRACT-0001",
        },
        report,
        frames: frames.map((f, i) => (i < 2 ? { ...f, cropDataUrl: CROP } : f)),
        visionTests: [],
        groundTruth: [{ eye: "OD", method: "autorefractor", sphere: -2.25, cylinder: -0.5, axis: 10 }],
      },
      { research: true, images: true, version: "eyeref-consent-1.0" },
      { protocolVersion: PROTOCOL_VERSION, device: SIM_DEVICE },
    );
    expect(upload.images).toHaveLength(2);
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(resolve(FIXTURES, "web_upload.sample.json"), JSON.stringify(upload, pin, 1));
  });
});
