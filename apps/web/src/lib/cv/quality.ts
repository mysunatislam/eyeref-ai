/** Frame-quality model - same sub-scores, thresholds and grading as backend/eyeref/cv/quality.py. */
import type {
  CaptureMetadata,
  PhotorefractionFeatures,
  QualityAssessment,
  QualityGrade,
  QualitySubscores,
} from "../types";
import { laplacianVariance, type RgbaImage } from "./image";
import type { EyeSegmentation } from "./segmentation";

export interface QualityConfig {
  minPupilMm: number;
  goodPupilMm: number;
  maxYawDeg: number;
  maxPitchDeg: number;
  maxGazeOffsetNorm: number;
  targetDistanceM: number;
  distanceToleranceM: number;
  minSharpness: number;
  goodSharpness: number;
  maxMotionPx: number;
  minPupilCoverage: number;
}

export const DEFAULT_QUALITY: QualityConfig = {
  minPupilMm: 3.0,
  goodPupilMm: 5.0,
  maxYawDeg: 15,
  maxPitchDeg: 15,
  maxGazeOffsetNorm: 0.55,
  targetDistanceM: 1.0,
  distanceToleranceM: 0.35,
  minSharpness: 0.0008,
  goodSharpness: 0.004,
  maxMotionPx: 4,
  minPupilCoverage: 0.75,
};

export const ramp = (x: number, bad: number, good: number) =>
  good === bad ? (x >= good ? 1 : 0) : Math.min(1, Math.max(0, (x - bad) / (good - bad)));

export const HARD_FAILURE_TEXT: Record<string, string> = {
  pupil_not_found: "Pupil not found",
  image_blurred: "Image blurred / out of focus",
  reflex_saturated: "Red reflex over-exposed",
  excessive_glare: "Corneal glare covers the pupil",
  pupil_occluded: "Pupil partly covered by eyelid",
  pupil_too_small: "Pupil too small (dim the room)",
  head_rotated: "Head turned or tilted",
  gaze_off_axis: "Not looking at the target",
  motion: "Motion during capture",
  distance_out_of_range: "Distance outside the guided range",
  no_red_reflex: "No red reflex (light source off?)",
};

const WEIGHTS: Record<keyof QualitySubscores, number> = {
  sharpness: 1.2,
  exposure: 0.8,
  saturation: 0.8,
  glare: 0.8,
  pupilVisibility: 1.2,
  pupilSize: 1.2,
  headPose: 0.8,
  gaze: 1.0,
  motion: 0.8,
  distance: 0.8,
  illumination: 1.0,
};

export function gradeFromScore(score: number, hard: string[]): QualityGrade {
  if (hard.length) return "reject";
  if (score >= 0.85) return "excellent";
  if (score >= 0.65) return "acceptable";
  if (score >= 0.45) return "poor";
  return "reject";
}

export function combineSubscores(s: QualitySubscores): number {
  let logsum = 0;
  let wsum = 0;
  for (const k of Object.keys(WEIGHTS) as (keyof QualitySubscores)[]) {
    logsum += WEIGHTS[k] * Math.log(Math.max(s[k], 0.02));
    wsum += WEIGHTS[k];
  }
  return Math.exp(logsum / wsum);
}

export function assessQuality(
  img: RgbaImage,
  seg: EyeSegmentation | null,
  f: PhotorefractionFeatures,
  meta: CaptureMetadata,
  cfg: QualityConfig = DEFAULT_QUALITY,
): QualityAssessment {
  const s: QualitySubscores = {
    sharpness: 0,
    exposure: 0,
    saturation: 0,
    glare: 0,
    pupilVisibility: 0,
    pupilSize: 0,
    headPose: 1,
    gaze: 0,
    motion: 1,
    distance: 1,
    illumination: 0,
  };
  const hard: string[] = [];
  const adv: string[] = [];
  if (!seg || !f.pupil) {
    return { score: 0, grade: "reject", subscores: s, hardFailures: ["pupil_not_found"], advisories: adv };
  }
  const { width: w, height: h } = img;
  const irisRegion = new Uint8Array(w * h);
  let lumSum = 0;
  let lumN = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if ((x - seg.iris.cx) ** 2 + (y - seg.iris.cy) ** 2 <= (1.1 * seg.iris.r) ** 2) {
        const i = y * w + x;
        irisRegion[i] = 1;
        lumSum +=
          (0.299 * img.data[4 * i]! + 0.587 * img.data[4 * i + 1]! + 0.114 * img.data[4 * i + 2]!) / 255;
        lumN++;
      }
    }
  const sharp = laplacianVariance(img, irisRegion);
  s.sharpness = ramp(sharp, cfg.minSharpness, cfg.goodSharpness);
  if (sharp < cfg.minSharpness) hard.push("image_blurred");

  const meanL = lumSum / Math.max(lumN, 1);
  s.exposure = ramp(meanL, 0.04, 0.15) * ramp(-meanL, -0.85, -0.6);

  let pupilN = 0;
  let clipped = 0;
  let glareN = 0;
  for (let i = 0; i < w * h; i++) {
    if (!seg.pupilMask[i]) continue;
    pupilN++;
    if (seg.glintMask[i]) glareN++;
    else if (img.data[4 * i]! >= 250) clipped++;
  }
  const clipFrac = clipped / Math.max(pupilN, 1);
  s.saturation = ramp(-clipFrac, -0.25, -0.03);
  if (clipFrac > 0.25) {
    hard.push("reflex_saturated");
    adv.push("Reduce exposure or increase distance: red reflex is clipped.");
  }
  const glareFrac = glareN / Math.max(pupilN, 1);
  s.glare = ramp(-glareFrac, -0.25, -0.06);
  if (glareFrac > 0.25) hard.push("excessive_glare");

  s.pupilVisibility = ramp(seg.pupilCoverage, 0.6, 0.92);
  if (seg.pupilCoverage < cfg.minPupilCoverage) {
    hard.push("pupil_occluded");
    adv.push("Pupil partly covered (eyelid/lashes). Ask the subject to open eyes wide.");
  }
  const pd = f.pupilDiameterMm ?? 0;
  s.pupilSize = ramp(pd, cfg.minPupilMm, cfg.goodPupilMm);
  if (pd < cfg.minPupilMm) {
    hard.push("pupil_too_small");
    adv.push("Pupil too small: dim the room and wait 1-2 minutes for dark adaptation.");
  }
  const hp = meta.headPose;
  s.headPose = Math.min(
    ramp(-Math.abs(hp.yawDeg), -cfg.maxYawDeg, -5),
    ramp(-Math.abs(hp.pitchDeg), -cfg.maxPitchDeg, -5),
  );
  if (Math.abs(hp.yawDeg) > cfg.maxYawDeg || Math.abs(hp.pitchDeg) > cfg.maxPitchDeg)
    hard.push("head_rotated");

  if (f.glintOffsetNorm) {
    const g = Math.hypot(...f.glintOffsetNorm);
    s.gaze = ramp(-g, -cfg.maxGazeOffsetNorm, -0.2);
    if (g > cfg.maxGazeOffsetNorm) hard.push("gaze_off_axis");
  } else {
    s.gaze = 0.5;
    adv.push("No corneal reflex found; gaze could not be verified.");
  }
  if (meta.motionPxPerFrame !== null) {
    s.motion = ramp(-meta.motionPxPerFrame, -cfg.maxMotionPx, -1);
    if (meta.motionPxPerFrame > cfg.maxMotionPx) hard.push("motion");
  }
  const dd = Math.abs(meta.workingDistanceM - cfg.targetDistanceM);
  s.distance = ramp(-dd, -cfg.distanceToleranceM, -0.1);
  if (dd > cfg.distanceToleranceM) hard.push("distance_out_of_range");

  if (meta.illumination === "none") {
    s.illumination = 0;
    adv.push("No eccentric light source: photorefraction is not possible.");
  } else {
    s.illumination = ramp(f.reflexMeanLuma ?? 0, 0.05, 0.18);
    if ((f.reflexMeanLuma ?? 0) < 0.05) hard.push("no_red_reflex");
  }
  const score = combineSubscores(s);
  return {
    score: Math.round(score * 1e4) / 1e4,
    grade: gradeFromScore(score, hard),
    subscores: s,
    hardFailures: hard,
    advisories: adv,
  };
}

export const isUsable = (q: QualityAssessment) => q.grade === "excellent" || q.grade === "acceptable";
