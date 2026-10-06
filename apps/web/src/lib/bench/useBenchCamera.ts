"use client";
/**
 * The camera for a bench run: the rear camera's raw frames, cropped around the search circle the
 * operator places on the model eye, through the same extractor and with the same light pulse as an
 * assessment's burst.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useCamera } from "../camera/useCamera";
import { scaleRgba } from "../cv/draw";
import { imageDataToRgba } from "../cv/image";
import { grabFrame, illuminationFor, MIN_CROP_PX } from "../protocol/live";
import { FRAME_INTERVAL_MS, TORCH_SETTLE_MS } from "../protocol/protocol";
import { eyeCropRect, focalPxFromHfov } from "../tracking/eyeGeometry";
import type { Circle, DeviceProfile } from "../types";
import { benchMetadata, processBenchFrame, type BenchRun, type BenchShot, type BenchStep } from "./run";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The crop around the search circle, upsampled as the live eye crops are, and the circle in it. */
export function cropAround(ctx: CanvasRenderingContext2D, search: Circle) {
  const { width: W, height: H } = ctx.canvas;
  const rect = eyeCropRect(search, W, H, 1.6);
  const raw = imageDataToRgba(
    ctx.getImageData(rect.x, rect.y, Math.max(rect.size, 1), Math.max(rect.size, 1)),
  );
  const { image, factor } = scaleRgba(raw, MIN_CROP_PX);
  return {
    image,
    search: { cx: (search.cx - rect.x) * factor, cy: (search.cy - rect.y) * factor, r: search.r * factor },
  };
}

/**
 * The search circle's starting radius: the model eye's pupil diameter in pixels, so the pupil fills
 * the middle half of the circle.
 */
export function expectedSearchRadiusPx(
  frameWidthPx: number,
  device: DeviceProfile,
  hfovDeg: number | null,
  pupilMm: number,
  distanceM: number,
) {
  const f = focalPxFromHfov(frameWidthPx, hfovDeg ?? device.hfovDeg);
  return Math.max(6, (f * pupilMm) / 1000 / distanceM);
}

/**
 * How far the screen is turned from the phone's natural orientation (0, 90, 180 or 270, anticlockwise
 * as you look at it). The browser turns the camera's frames with the screen, so this, and not the
 * phone's tilt, is how far the light's direction turns in a frame. Null where the browser does not say.
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

export function useBenchCamera() {
  const cam = useCamera();
  const frameCanvas = useRef<HTMLCanvasElement | null>(null);

  /** One step's burst: the light on, a settle, the frames, the light off again unless it was on. */
  const captureStep = useCallback(
    async (
      run: BenchRun,
      step: BenchStep,
      search: Circle,
      opts: { frameRotationDeg: number | null; lightWasOn: boolean },
    ): Promise<BenchShot[]> => {
      const video = cam.videoRef.current;
      if (!video) throw new Error("The camera is not running.");
      if (!frameCanvas.current) frameCanvas.current = document.createElement("canvas");
      let light = opts.lightWasOn;
      if (!light && run.device.camera === "rear" && cam.caps?.torch) {
        light = await cam.setTorch(true);
        await sleep(TORCH_SETTLE_MS);
      }
      const shots: BenchShot[] = [];
      try {
        for (let i = 0; i < run.setup.framesPerStep; i++) {
          const ctx = grabFrame(video, frameCanvas.current);
          if (ctx) {
            const crop = cropAround(ctx, search);
            const frameIndex = step.index * run.setup.framesPerStep + i;
            const meta = benchMetadata(run.setup, step, frameIndex, {
              simulated: false,
              illumination: illuminationFor(run.device, light),
              frameRotationDeg: opts.frameRotationDeg,
            });
            const { record, segmentation } = processBenchFrame(
              crop.image,
              crop.search,
              meta,
              run.device,
              run.setup,
            );
            shots.push({
              frame: {
                lensD: step.lensD,
                refractionD: step.refractionD,
                rotationDeg: step.rotationDeg,
                record,
              },
              image: crop.image,
              segmentation,
            });
          }
          await sleep(FRAME_INTERVAL_MS);
        }
      } finally {
        if (light && !opts.lightWasOn) await cam.setTorch(false);
      }
      return shots;
    },
    [cam],
  );

  return { ...cam, captureStep };
}
