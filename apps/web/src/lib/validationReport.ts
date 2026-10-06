/** Types for ml/reports/*.json (produced by ml/eyeref_ml/training/run_experiments.py). Snake_case as written. */
export interface Reg {
  n: number;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  within_0_25: number | null;
  within_0_50: number | null;
  within_1_00: number | null;
  pearson_r: number | null;
  fraction_quantitative?: number | null;
  fraction_range?: number | null;
}
export interface Screen {
  n: number;
  prevalence: number;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  sensitivity: number | null;
  specificity: number | null;
  ppv: number | null;
  npv: number | null;
  roc_auc: number | null;
  roc?: { fpr: number; tpr: number }[];
}
export interface EyeMetrics {
  n_eyes: number;
  output_levels: Record<string, number>;
  se_all_eyes: Reg;
  se_released_only: Reg;
  se_ci95_coverage: number | null;
  /** Eyes that focusing on the light leaves open get a range: how many, and how often it holds the truth. */
  ranges?: { n: number; fraction: number | null; coverage: number | null; coverage_all_eyes: number | null };
  /** Eyes given a class, and how often it was right. */
  classes?: { n: number; fraction: number | null; accuracy: number | null; wrong: Record<string, number> };
  sphere: Reg;
  cylinder: Reg;
  J0: Reg;
  J45: Reg;
  axis: {
    n: number;
    mean_abs_error_deg: number | null;
    median_abs_error_deg: number | null;
    within_5: number | null;
    within_10: number | null;
    within_20: number | null;
  };
  bland_altman_se: {
    n: number;
    mean_diff: number;
    sd_diff: number;
    loa_low: number;
    loa_high: number;
    proportional_bias_slope: number;
    points: { mean: number; diff: number }[];
  };
  screening_myopia: Screen;
  screening_hyperopia: Screen;
  screening_astigmatism: Screen;
  anisometropia: Screen;
  rejection: { n: number } & Record<string, { fraction: number; mae_if_used: number | null } | number>;
}
export interface ModelResult {
  /** Against the model's target: in simulation, the meridian as the camera saw it. */
  frame: Reg;
  eye: EyeMetrics;
  /** Whether the app allows for the eyes focusing on the light with this model's readings. */
  focus_model?: boolean;
  train_seconds?: number;
  training_history?: { epoch: number; loss: number }[];
  conformal_scale?: number;
  subgroups?: Record<string, Record<string, Reg>>;
}
export interface Experiment {
  description: string;
  n_train_subjects?: number;
  n_test_subjects: number;
  held_out_device?: string;
  models: Record<string, ModelResult>;
}
export interface ValidationReport {
  generated_at: string;
  eyeref_ml_version: string;
  simulated: boolean;
  /**
   * What the models learned per frame: "optical", the meridian as the camera saw it (simulation), or
   * "clinical", the eye's own refraction (a real study). Reports made before it was recorded learned clinical.
   */
  target?: "optical" | "clinical";
  warning: string;
  dataset: {
    simulated: boolean;
    n_subjects: number;
    n_frames: number;
    seed: number;
    devices: string[];
    warning: string;
  };
  gating: Record<string, number | boolean>;
  experiments: Record<string, Experiment>;
  /** Frame errors against the target, on the devices seen in training and on the held-out one. */
  cross_device_degradation: Record<
    string,
    { in_distribution_mae: number; unseen_device_mae: number; degradation_d: number }
  >;
}

export const MODEL_LABEL: Record<string, string> = {
  physics_only: "Physics only (no learning)",
  ridge: "Ridge regression",
  poly2_ridge: "Polynomial ridge",
  random_forest: "Random forest",
  gradient_boosting: "Gradient boosting",
  hybrid_features: "Hybrid NN (features)",
  hybrid_cnn: "Hybrid NN (CNN + features)",
};
