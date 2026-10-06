import { describe, expect, it } from "vitest";
import { frameRotationDeg, probedRotationDeg, turnToTarget } from "../camera/orientation";
import { EXTRACTOR_VERSION } from "../cv/features";
import { meridianEyeDeg } from "../devices";
import { PhysicsHeuristicEstimator } from "../inference/estimators";
import { buildReport } from "../inference/fusion";
import { processFrame } from "../inference/pipeline";
import { circularAxisError } from "../optics/powerVector";
import { evaluateReadiness, rotationError, type ReadinessInput } from "../protocol/readiness";
import {
  makeSubject,
  SIM_DEVICE,
  simulatedScreenAngle,
  simulateFrame,
  type VirtualSubject,
} from "../simulation/session";
import type { CaptureMetadata, FrameRecord } from "../types";

describe("a frame's rotation", () => {
  it("is the screen's for the rear camera, and the screen's the other way for the front one", () => {
    expect([0, 90, 180, 270].map((a) => frameRotationDeg(a, "environment"))).toEqual([0, 90, 180, 270]);
    expect([0, 90, 180, 270].map((a) => frameRotationDeg(a, "user"))).toEqual([0, 270, 180, 90]);
    expect(frameRotationDeg(-90, "environment")).toBe(270);
    expect(frameRotationDeg(null, "environment")).toBe(0);
  });

  it("with the eyes' tilt in it, gives the phone's turn from the head", () => {
    // a phone at 45° whose screen stayed in portrait: the head leans the other way in the picture
    expect(probedRotationDeg(0, -45)).toBe(45);
    // on its side, with the screen in landscape either way round: the head is upright in the picture
    expect(probedRotationDeg(90, 0)).toBe(90);
    expect(probedRotationDeg(270, 0)).toBe(90);
    // at 135°, landscape: the head leans 45° the other way
    expect(probedRotationDeg(90, -45)).toBe(135);
    expect(probedRotationDeg(0, 45)).toBe(135);
  });

  it("says which way to turn the phone, as its screen is seen", () => {
    expect(turnToTarget(rotationError(30, 45), "environment")).toBe("anticlockwise");
    expect(turnToTarget(rotationError(60, 45), "environment")).toBe("clockwise");
    expect(turnToTarget(rotationError(30, 45), "user")).toBe("clockwise");
    expect(turnToTarget(rotationError(60, 45), "user")).toBe("anticlockwise");
    // 135° is reached the short way, 45° clockwise from upright
    expect(turnToTarget(rotationError(0, 135), "environment")).toBe("clockwise");
    expect(turnToTarget(0, "environment")).toBeNull();
  });

  it("puts the way to turn in the angle indicator", () => {
    const input: ReadinessInput = {
      face: true,
      distanceM: 1,
      targetDistanceM: 1,
      luma: 0.16,
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: -20,
      gaze: 0.02,
      blink: 0.05,
      motionPx: 0.5,
      pupilMm: 6,
      grade: "excellent",
      flashAvailable: true,
      deviceRotationErrorDeg: -25,
      deviceTurn: "anticlockwise",
    };
    const angle = (i: ReadinessInput) => evaluateReadiness(i).indicators.find((x) => x.key === "meridian")!;
    expect(angle(input)).toMatchObject({
      value: "25° off",
      state: "bad",
      hint: "Turn the phone anticlockwise",
    });
    expect(evaluateReadiness(input).ready).toBe(false);
    expect(angle({ ...input, deviceRotationErrorDeg: 3 })).toMatchObject({ state: "ok", hint: undefined });
  });
});

describe("the light's direction in a live frame", () => {
  const est = new PhysicsHeuristicEstimator();
  const subject: VirtualSubject = {
    ...makeSubject("ROTATION-1", "adult_18_39"),
    od: { sph: -3.5, cyl: 0, axis: null },
  };
  const astig: VirtualSubject = {
    ...makeSubject("ROTATION-2", "adult_18_39"),
    od: { sph: -0.5, cyl: -3.5, axis: 180 },
  };
  const shot = (s: VirtualSubject, rotationDeg: number, frameRotation: number, i = 0) =>
    simulateFrame(s, "OD", rotationDeg, 100 + i, 7, {
      blinkRate: 0,
      motionRate: 0,
      frameRotationDeg: frameRotation,
    });
  const estimate = (sf: ReturnType<typeof shot>, meta: CaptureMetadata = sf.metadata) =>
    processFrame(sf.image, sf.iris, meta, SIM_DEVICE, est).record.estimate!;
  // what the app recorded before: the tilt sensor's angle, on the 180° circle, as the frame's rotation
  const tiltSensor = (sf: ReturnType<typeof shot>, rotationDeg: number) => ({
    ...sf.metadata,
    deviceRotationDeg: rotationDeg % 180,
  });

  it("probes the step's meridian with the phone at 45° and the screen still in portrait", () => {
    for (let i = 0; i < 4; i++) {
      const sf = shot(astig, 45, 0, i);
      expect(sf.metadata.deviceRotationDeg).toBe(0);
      expect(sf.metadata.headPose.rollDeg).toBeLessThan(-35);
      const e = estimate(sf);
      expect(circularAxisError(e.meridianDeg!, sf.truthMeridianDeg)).toBeLessThan(1e-6);
      expect(Math.abs(e.powerD! - sf.truthPowerD)).toBeLessThan(0.75);
      // the tilt sensor's angle on top of the eyes' tilt counted the turn twice
      expect(
        circularAxisError(meridianEyeDeg(tiltSensor(sf, 45), SIM_DEVICE)!, sf.truthMeridianDeg),
      ).toBeCloseTo(45, 0);
    }
  });

  it("matches a frame that turned with the phone", () => {
    const portrait = estimate(shot(astig, 45, 0));
    const turned = estimate(shot(astig, 45, 45));
    expect(circularAxisError(portrait.meridianDeg!, turned.meridianDeg!)).toBeLessThan(6);
    expect(Math.abs(portrait.powerD! - turned.powerD!)).toBeLessThan(0.75);
  });

  it("probes the 90° meridian with the screen held in portrait, as the installed app holds it", () => {
    const sf = shot(subject, 90, 0);
    expect(sf.metadata.headPose.rollDeg).toBeLessThan(-80);
    const e = estimate(sf);
    expect(circularAxisError(e.meridianDeg!, sf.truthMeridianDeg)).toBeLessThan(1e-6);
    expect(Math.abs(e.powerD! - sf.truthPowerD)).toBeLessThan(0.5);
    // the tilt sensor's 90° on top of the eyes' tilt probed the 0° meridian again, across the crescent
    const old = estimate(sf, tiltSensor(sf, 90));
    expect(circularAxisError(old.meridianDeg!, sf.truthMeridianDeg)).toBeGreaterThan(80);
    expect(Math.abs(old.powerD! - sf.truthPowerD)).toBeGreaterThan(2);
  });

  it("keeps the light's side with the phone turned either way onto its side", () => {
    // anticlockwise, the screen turns to 90°; clockwise, to 270°: the same meridian, the light opposite
    for (const turn of [90, 270]) {
      const sf = shot(subject, turn, turn);
      expect(Math.abs(sf.metadata.headPose.rollDeg)).toBeLessThan(10);
      const e = estimate(sf);
      expect(e.status).toBe("quantitative");
      expect(circularAxisError(e.meridianDeg!, 0)).toBeLessThan(10);
      expect(Math.abs(e.powerD! - sf.truthPowerD)).toBeLessThan(0.5);
    }
    // turned clockwise, the tilt sensor's angle on the 180° circle put the light on the wrong side, and
    // a myope read as a hyperope
    const sf = shot(subject, 270, 270);
    const wrong = estimate(sf, tiltSensor(sf, 270));
    expect(sf.truthPowerD).toBeLessThan(-3);
    expect(wrong.powerD).toBeGreaterThan(0);
  });

  it("turns the simulated phone's screen to landscape only once the phone is on its side", () => {
    expect([0, 45, 90, 135].map(simulatedScreenAngle)).toEqual([0, 0, 90, 90]);
    expect([-45, -90, 270, 225].map(simulatedScreenAngle)).toEqual([0, 270, 270, 270]);
  });

  it("gives a simulated assessment the same astigmatism whether the frames turn with the screen or the phone", () => {
    const both: VirtualSubject = { ...astig, os: { sph: -1, cyl: -2.5, axis: 60 } };
    const fused = (screen: boolean) => {
      const frames: FrameRecord[] = [];
      for (const rot of [0, 45, 90, 135])
        for (let i = 0; i < 4; i++)
          for (const eye of ["OD", "OS"] as const) {
            const sf = simulateFrame(both, eye, rot, rot * 10 + i, 3, {
              blinkRate: 0,
              motionRate: 0,
              frameRotationDeg: screen ? simulatedScreenAngle(rot) : undefined,
            });
            frames.push({
              ...processFrame(sf.image, sf.iris, sf.metadata, SIM_DEVICE, est).record,
              protocolRotationDeg: rot,
            });
          }
      return buildReport({
        frames,
        ageGroup: both.ageGroup,
        deviceId: SIM_DEVICE.id,
        calibrationVersion: SIM_DEVICE.calibrationVersion,
        estimator: { name: est.name, version: est.version, kind: est.kind },
        extractorVersion: EXTRACTOR_VERSION,
        id: "rotation",
      });
    };
    const screen = fused(true);
    const phone = fused(false);
    for (const eye of ["OD", "OS"] as const) {
      const a = screen.eyes[eye].powerVector!;
      const b = phone.eyes[eye].powerVector!;
      expect(screen.eyes[eye].meridians.length).toBe(4);
      expect(Math.abs(a.M - b.M)).toBeLessThan(0.25);
      expect(Math.hypot(a.J0 - b.J0, a.J45 - b.J45)).toBeLessThan(0.25);
      // the astigmatism's axis survives the head's lean at 45° and 135° (its size is shrunk by the prior)
      const rx = both[eye === "OD" ? "od" : "os"];
      expect(Math.hypot(a.J0, a.J45)).toBeGreaterThan(0.5);
      expect(circularAxisError(screen.eyes[eye].research!.axis!, rx.axis!)).toBeLessThan(10);
    }
  }, 30_000);
});
