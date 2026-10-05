/**
 * Typed contracts mirroring backend/eyeref/types.py and inference/fusion.py.
 * Field names use camelCase in the browser; lib/api.ts converts at the boundary.
 */

export type EyeSide = "OD" | "OS"; // OD = right eye, OS = left eye
export type Illumination = "flash" | "torch" | "external_visible" | "nir850" | "none";
export type QualityGrade = "excellent" | "acceptable" | "poor" | "reject";
export type EstimateStatus = "quantitative" | "interval" | "insufficient";
export type OutputLevel = "quantitative" | "screening" | "repeat";
export type RefractiveClass = "myopia" | "emmetropia" | "hyperopia";
export type AgeGroup =
  "child_3_7" | "child_8_12" | "teen" | "adult_18_39" | "adult_40_59" | "adult_60_plus" | "unknown";

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

export interface DeviceProfile {
  id: string;
  manufacturer: string;
  model: string;
  camera: "rear" | "front" | "webcam" | "external";
  hfovDeg: number;
  /** lens centre -> light-source centre, mm, captured-image frame (x right, y up) */
  flashOffsetMm: [number, number] | null;
  apertureDiameterMm: number;
  /** dead-zone gradient gain (half-widths per unit slope); null = uncalibrated */
  gradientGain: number | null;
  gradientRelSd: number;
  calibrationVersion: string;
  simulated?: boolean;
  notes: string;
}

export interface HeadPose {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface CaptureMetadata {
  eye: EyeSide;
  timestamp: string;
  workingDistanceM: number;
  distanceSource: "iris" | "manual" | "calibrated" | "simulated";
  distanceSdM: number;
  deviceRotationDeg: number;
  headPose: HeadPose;
  illumination: Illumination;
  sourceAngleImageDeg: number | null;
  eccentricityMm: number | null;
  mirrored: boolean;
  ageGroup: AgeGroup;
  frameIndex: number;
  simulated: boolean;
  motionPxPerFrame: number | null;
}

export interface PhotorefractionFeatures {
  pupil: Circle | null;
  iris: Circle | null;
  glint: [number, number] | null;
  pupilDiameterMm: number | null;
  pupilToIrisRatio: number | null;
  pupilEllipseEccentricity: number | null;
  reflexMeanLuma: number | null;
  reflexMeanRgb: [number, number, number] | null;
  reflexRedChroma: number | null;
  reflexEntropy: number | null;
  crescentPresent: boolean;
  crescentAreaFraction: number;
  crescentWidthNorm: number;
  crescentWidthMm: number;
  crescentSide: -1 | 0 | 1;
  crescentCentroidOffsetNorm: number;
  crescentOrientationDeg: number | null;
  crescentContrast: number;
  crescentSeparability: number;
  gradientAlongSource: number;
  gradientPerpendicular: number;
  dominantGradientDeg: number | null;
  asymmetryIndex: number;
  profileAlongSource: (number | null)[];
  profilePerpendicular: (number | null)[];
  profilePolyCoeffs: number[];
  radialProfile: (number | null)[];
  glintOffsetNorm: [number, number] | null;
  sourceAngleImageDeg: number | null;
  extractorVersion: string;
}

export interface QualitySubscores {
  sharpness: number;
  exposure: number;
  saturation: number;
  glare: number;
  pupilVisibility: number;
  pupilSize: number;
  headPose: number;
  gaze: number;
  motion: number;
  distance: number;
  illumination: number;
}

export interface QualityAssessment {
  score: number;
  grade: QualityGrade;
  subscores: QualitySubscores;
  hardFailures: string[];
  advisories: string[];
}

export interface MeridionalEstimate {
  meridianDeg: number | null;
  status: EstimateStatus;
  powerD: number | null;
  sigmaD: number | null;
  intervalD: [number, number] | null;
  estimator: string;
  estimatorVersion: string;
  notes: string[];
}

export interface FrameRecord {
  metadata: CaptureMetadata;
  features: PhotorefractionFeatures;
  quality: QualityAssessment;
  estimate: MeridionalEstimate | null;
  /** small PNG data URL of the eye crop - stored locally only, and only with consent */
  cropDataUrl?: string;
  /** nominal device rotation of the protocol step this frame belongs to (measured value is in metadata) */
  protocolRotationDeg?: number;
  /** simulator ground truth (SIMULATION MODE only) */
  simTruth?: { powerInMeridianD: number; meridianDeg: number };
}

export interface MeridianSummary {
  meridianDeg: number;
  nFrames: number;
  nUsable: number;
  status: EstimateStatus;
  powerD: number | null;
  sigmaD: number | null;
  temporalSdD: number | null;
  intervalD: [number, number] | null;
  framePowers: number[];
}

export interface EyeResult {
  eye: EyeSide;
  outputLevel: OutputLevel;
  message: string;
  seD: number | null;
  seCi95: [number, number] | null;
  sphD: number | null;
  sphCi95: [number, number] | null;
  cylD: number | null;
  cylCi95: [number, number] | null;
  axisDeg: number | null;
  axisUncertaintyDeg: number | null;
  powerVector: { M: number; J0: number; J45: number } | null;
  powerVectorSd: { M: number; J0: number; J45: number } | null;
  refractiveClass: RefractiveClass | null;
  severity: string | null;
  classProbabilities: Record<RefractiveClass, number> | null;
  astigmatismStatus: "quantified" | "screening_only" | "not_assessed";
  astigmatismProbability: number | null;
  confidence: number | null;
  qualityGrade: QualityGrade | null;
  medianQuality: number | null;
  nFrames: number;
  nUsableFrames: number;
  meridians: MeridianSummary[];
  reflexMeanLuma: number | null;
  deadZoneD: [number, number] | null;
  /** ungated research view of the posterior (research dashboard only) */
  research: {
    sph: number | null;
    cyl: number | null;
    axis: number | null;
    sphSamples: number[];
    cylSamples: number[];
    axisSamples: number[];
    axisSdDeg: number | null;
  } | null;
  notes: string[];
}

export interface Provenance {
  modelName: string;
  modelVersion: string;
  estimatorKind: string;
  calibrationVersion: string;
  deviceProfile: string;
  extractorVersion: string;
  appVersion: string;
  timestamp: string;
}

export interface AssessmentReport {
  id: string;
  simulated: boolean;
  eyes: Record<EyeSide, EyeResult>;
  anisometropiaProbability: number | null;
  seDifferenceD: number | null;
  reflexAsymmetryRatio: number | null;
  reflexAsymmetryFlag: boolean;
  referralReasons: string[];
  interpretation: string;
  disclaimer: string;
  provenance: Provenance;
}

export interface SubjectProfile {
  label: string; // free-text nickname kept on-device only
  ageGroup: AgeGroup;
  wearsCorrection: "none" | "glasses" | "contacts" | "unknown";
  symptoms: boolean;
  consentImages: boolean;
  datasetCode?: string; // pseudonymous code in Dataset Collection Mode
}

export interface VisionTestResult {
  eye: EyeSide | "OU";
  logMar: number | null;
  snellen: string | null;
  distanceM: number;
  astigmaticDialReport: "none" | "lines_unequal" | "unsure" | null;
  timestamp: string;
}

export interface StoredAssessment {
  id: string;
  createdAt: string;
  profile: SubjectProfile;
  report: AssessmentReport;
  frames: FrameRecord[];
  visionTests: VisionTestResult[];
  simTruth?: Record<EyeSide, { sph: number; cyl: number; axis: number | null; se: number }>;
  groundTruth?: GroundTruthEntry[];
  /** set once the record is stored on a research server (Dataset collection) */
  upload?: UploadReceipt;
}

/** Where and when a record was stored on the research server, and what went with it. */
export interface UploadReceipt {
  at: string;
  server: string;
  subjectId: string;
  sessionId: string;
  captures: number;
  imagesStored: number;
}

export interface GroundTruthEntry {
  eye: EyeSide;
  method: "autorefractor" | "subjective" | "cycloplegic" | "retinoscopy" | "trial_lens";
  sphere: number;
  cylinder: number;
  axis: number | null;
  instrument?: string;
}
