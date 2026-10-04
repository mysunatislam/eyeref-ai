/** Frame pipeline: eye crop -> segmentation -> features -> quality -> meridional estimate. */
import { effectiveSourceAngle } from "../devices";
import { extractFeatures } from "../cv/features";
import type { RgbaImage } from "../cv/image";
import { assessQuality, DEFAULT_QUALITY, isUsable, type QualityConfig } from "../cv/quality";
import type { EyeSegmentation } from "../cv/segmentation";
import type { CaptureMetadata, Circle, DeviceProfile, FrameRecord } from "../types";
import type { PhotorefractionEstimator } from "./estimators";

export interface ProcessedFrame {
  record: FrameRecord;
  segmentation: EyeSegmentation;
}

/** Un-mirror a selfie-style capture so TABO angles are valid (theta -> 180 - theta). */
export function unmirrorMetadata(meta: CaptureMetadata): CaptureMetadata {
  if (!meta.mirrored) return meta;
  return {
    ...meta,
    mirrored: false,
    sourceAngleImageDeg:
      meta.sourceAngleImageDeg === null ? null : (((180 - meta.sourceAngleImageDeg) % 360) + 360) % 360,
    headPose: { ...meta.headPose, rollDeg: -meta.headPose.rollDeg },
  };
}

export function processFrame(
  crop: RgbaImage,
  iris: Circle,
  metaIn: CaptureMetadata,
  device: DeviceProfile,
  estimator: PhotorefractionEstimator,
  qualityCfg: QualityConfig = DEFAULT_QUALITY,
): ProcessedFrame {
  // Crops handed to the pipeline are always taken from the RAW (non-mirrored) camera frame,
  // so only metadata needs un-mirroring if the caller flagged it.
  const meta = unmirrorMetadata(metaIn);
  const flash = meta.illumination !== "none";
  const src = effectiveSourceAngle(meta, device);
  const { features, segmentation } = extractFeatures(crop, src, iris, flash);
  const quality = assessQuality(crop, segmentation, features, meta, qualityCfg);
  const estimate = isUsable(quality) ? estimator.estimate(features, meta, device) : null;
  return { record: { metadata: meta, features, quality, estimate }, segmentation };
}
