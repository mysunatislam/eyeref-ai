"use client";
/**
 * Which way the light lies in a camera frame, and how far the phone is turned from the head.
 *
 * A browser hands a phone camera's frames to the page turned with the screen, so the scene stays upright
 * on it. A frame's own rotation is therefore the screen's, in steps of 90°, and not the phone's tilt: the
 * rest of the phone's turn shows in the picture, as the tilt of the eyes. The light's direction in a
 * frame is the device profile's reference angle plus the frame's rotation, and the meridian it probes in
 * the eye is that less the eyes' tilt (`meridianEyeDeg`). Adding the phone's tilt as well would count
 * the same turn twice.
 */
import { useEffect, useState } from "react";
import type { Facing } from "./useCamera";

/**
 * How far the screen is turned from the phone's natural orientation (0, 90, 180 or 270, anticlockwise as
 * you look at it), or null where the browser does not say.
 */
export function useScreenAngle(): number | null {
  const [angle, setAngle] = useState<number | null>(null);
  useEffect(() => {
    const read = () => {
      const a =
        window.screen?.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation;
      setAngle(typeof a === "number" ? ((a % 360) + 360) % 360 : null);
    };
    read();
    const so = window.screen?.orientation;
    so?.addEventListener?.("change", read);
    window.addEventListener("orientationchange", read);
    return () => {
      so?.removeEventListener?.("change", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);
  return angle;
}

/**
 * How far a frame is turned from one taken with the screen at its natural orientation, anticlockwise in
 * the unmirrored image. The rear camera looks the way you do as you look at the screen, so the screen's
 * turn is the frame's. The front camera looks back at you, so the same turn runs the other way in its
 * image. A browser that does not say how the screen is turned is taken not to turn the frames.
 */
export function frameRotationDeg(screenAngleDeg: number | null, facing: Facing): number {
  if (screenAngleDeg === null) return 0;
  const a = ((screenAngleDeg % 360) + 360) % 360;
  return facing === "user" ? (360 - a) % 360 : a;
}

/**
 * The phone's turn from the head on the meridian circle (0 to 180), as the camera sees it: the frame's
 * rotation less the eyes' tilt in the frame. This is the meridian a step probes, less the device's
 * reference angle, whatever the screen did.
 */
export function probedRotationDeg(frameRotation: number, headRollImageDeg: number): number {
  return (((frameRotation - headRollImageDeg) % 180) + 180) % 180;
}

/**
 * Which way to turn the phone, as you look at its screen, to bring `errorDeg` (probed less target) to 0.
 * With the rear camera the probed rotation grows as you turn the phone anticlockwise; the front camera
 * faces the other way, so for it the probed rotation grows as you turn the phone clockwise.
 */
export function turnToTarget(errorDeg: number, facing: Facing): "clockwise" | "anticlockwise" | null {
  if (errorDeg === 0) return null;
  const lower = errorDeg > 0;
  return lower === (facing === "environment") ? "clockwise" : "anticlockwise";
}
