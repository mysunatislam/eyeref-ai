/**
 * Cross-language contract: a report built by the browser pipeline, converted at the API boundary,
 * is written to shared/fixtures so backend/tests/test_contract.py can validate it with pydantic.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { camel, slimReport, snake } from "../api";
import { EXTRACTOR_VERSION } from "../cv/features";
import { PhysicsHeuristicEstimator } from "../inference/estimators";
import { buildReport } from "../inference/fusion";
import { processFrame } from "../inference/pipeline";
import { makeSubject, SIM_DEVICE, simulateFrame } from "../simulation/session";
import type { FrameRecord } from "../types";

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
    const s = makeSubject("CONTRACT-1", "adult_18_39");
    const est = new PhysicsHeuristicEstimator();
    const frames: FrameRecord[] = [];
    for (const rot of [0, 45, 90, 135])
      for (let i = 0; i < 4; i++)
        for (const eye of ["OD", "OS"] as const) {
          const f = simulateFrame(s, eye, rot, rot * 10 + i, 1, { blinkRate: 0, motionRate: 0 });
          frames.push(processFrame(f.image, f.iris, f.metadata, SIM_DEVICE, est).record);
        }
    const rep = buildReport({
      frames,
      ageGroup: "adult_18_39",
      deviceId: SIM_DEVICE.id,
      calibrationVersion: SIM_DEVICE.calibrationVersion,
      estimator: { name: est.name, version: est.version, kind: est.kind },
      extractorVersion: EXTRACTOR_VERSION,
      id: "contract-fixture",
    });
    expect(rep.simulated).toBe(true);
    const dir = resolve(__dirname, "../../../../../shared/fixtures");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "web_report.sample.json"), JSON.stringify(snake(slimReport(rep)), null, 1));
    writeFileSync(resolve(dir, "web_frame.sample.json"), JSON.stringify(snake(frames[0]), null, 1));
  });
});
