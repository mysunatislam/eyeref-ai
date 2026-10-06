# Model training

All commands run from the repository root with the virtualenv created by `make setup`.

```bash
make data       # python -m eyeref_ml.datasets.synthetic --subjects 240 --out data/synthetic --seed 0
make ml-train   # python -m eyeref_ml.training.run_experiments --data data/synthetic --out reports/latest \
                #        --artifacts artifacts --epochs 12 --holdout-device sim-D --publish-web
```

The dataset and every model above are **SIMULATED**. `MANIFEST.json` and the report both say so, and
each exported ONNX sidecar carries `"trained_on_simulated": true`. A sidecar with that flag makes the
serving estimator refuse real frames (`backend/tests/test_inference.py`). To train on a study's data,
see [Training on real data](#training-on-real-data).

## Ladder of models (simplest first)

| # | Model | Inputs | Why it is here |
| --- | --- | --- | --- |
| 0 | Physics only | crescent inversion / dead-zone interval | Floor; no learning |
| 1 | Ridge | features + physics prior | Linear baseline |
| 2 | Polynomial ridge | degree-2 features | Cheap non-linearity |
| 3 | Random forest | features | Robust tabular baseline |
| 4 | Gradient boosting | features | Strong tabular baseline |
| 5 | Hybrid NN | features, `mu = prior + delta`, heteroscedastic | Physics-anchored learning |
| 6 | Hybrid CNN | crop + features | Uses pixels the features miss |

Every model predicts **per-meridian power with an uncertainty**. Eye-level SE, CYL and axis always
come from the same Bayesian fusion and gating code that the app uses
(`evaluation/eye_level.py` calls the runtime `fuse_eye`). That way the comparison measures what a
person would actually see.

## Uncertainty

- Tree and linear models get a σ from **group-conformal** residuals on the calibration subjects.
- NN models predict `log σ²`, and the prediction is multiplied by the split-conformal scale
  (`q/1.96`) that makes calibration-set 95% coverage hold. The scale is stored in the ONNX sidecar.
- MC dropout gives an epistemic check, which is reported but not used for gating.

## Versioning

Each export writes `<name>.onnx` and `<name>.json`. The sidecar records:

- `model_name` and `model_version`;
- the framework version and the export time;
- the ordered `feature_names` and their normalisation statistics;
- the `conformal_scale`;
- `trained_on_simulated`, the feature extractor version, and the dataset manifest (subjects, frames,
  devices, and the seed of a simulated dataset);
- a metrics summary.

Every prediction stores the model name and version, the extractor version and the calibration version.
To change any input feature, bump `EXTRACTOR_VERSION` in both implementations. Training never mixes
extractor versions: the dataset converter refuses to, and a model refuses features from any extractor
other than the one it was trained on.

## Simulated results and what they teach (SIMULATED DATA)

These are SE mean absolute errors across all test eyes, from the simulator before its eyes focused on
the light (PHOTOREFRACTION.md § 5). A rerun will move them: the frames now show the focusing, while
the targets stay each eye's own refraction, as a clinical refraction would give them.

| Model | Subject split | Unseen device |
| --- | --- | --- |
| Physics only | 0.54 D | 0.69 D |
| Random forest | 0.17 D | 0.21 D |
| Hybrid CNN | 0.17 D | 0.41 D |

1. On simulated data, neither the hybrid NN nor the CNN beats the tree ensembles. Deep learning is
   justified only if real data shows effects that the features miss, such as fundus colour or
   aberrations.
2. Learned models degrade on an unseen device more than physics does. Conformal coverage calibrated on
   seen devices drops to 57–86% on the new device for the linear and NN models. Ship **per-device
   calibration**, and recalibrate the conformal scale on each device.
3. The gate matters. "Released" eyes, the ones that passed every gate, have lower error than all eyes
   (for example, 0.14 vs 0.17 D for the random forest). In this simulation, children were never
   released as quantitative, because the accommodation uncertainty is too wide.

## Training on real data

Collect paired data first (RESEARCH_PROTOCOL.md). Then export the frames from the research server with an
analysis or admin token, `GET /api/dataset/export`, and turn them into a training dataset:

```bash
make dataset EXPORT=eyeref_dataset.csv  # python -m eyeref_ml.datasets.from_export eyeref_dataset.csv --out data/development
make ml-train-dev                       # the experiments above on it; add HOLDOUT=<device id> to test an unseen phone
```

The dataset has the simulated dataset's columns, so every model above trains on it unchanged. The
dataset, the report and the ONNX files go to `ml/data/development`, `ml/reports/development` and
`ml/artifacts/development`, which git ignores. The report lists study eyes, so `--publish-web` refuses
to put it in the web app.

**Targets.**

- Each eye's target at a visit is one reference refraction measured at that visit. By default it is the
  best one available: cycloplegic, then subjective, autorefractor, retinoscopy, trial lens. `--reference`
  chooses one method instead.
- The reference is used as recorded, usually at the spectacle plane. The study treats the app's numbers
  as being at that plane: it compares them with the reference directly, and beyond 4 D it converts both
  to the cornea alike.
- Each frame's target is that refraction's power along the frame's meridian,
  P(θ) = M + J0·cos 2θ + J45·sin 2θ.

**Frames.** Every frame keeps its quality grade. Training uses only the frames that passed, as the app
does, and the evaluation still counts the rest.

**What is left out.** `MANIFEST.json` counts each frame left out under the first of these reasons that
applies:

- its subject is listed with `--exclude-subjects` (see below);
- it was photographed under cycloplegia, which the app never sees (`--with-cycloplegia` keeps those);
- its session has a condition label, such as a lens held in front of the eye, so the reference may not
  describe the eye as photographed (`--condition <label>` keeps one label);
- its features come from another extractor version than the one chosen;
- it has no features, no quality assessment, no meridian, or no light-source geometry;
- no reference was measured for its eye at that visit.

**What is refused.**

- An export that mixes simulated and real data.
- An export with features from more than one extractor version, until `--extractor-version` chooses one.
  A model's inputs must all come from one extractor.

**Train on a development cohort, never on the validation study's subjects.** `--exclude-subjects`
takes another export, such as the validation study's eye export, and leaves out every subject in it,
matched by id or by study code. A model is validated only on subjects it never saw
(VALIDATION_PROTOCOL.md).

**What the model records.** The sidecar of each model trained this way records:

- `trained_on_simulated: false` and the dataset manifest;
- the extractor version, so the server refuses features from any other extractor
  (`backend/tests/test_inference.py`);
- a version of its own, `0.1.0+<UTC time>`, so the results of two models trained on real data are never
  mixed up in one study. The study analysis refuses results from more than one version.

**The image branch.** The CNN needs eye crops. The server keeps them only with consent and does not
export them, so only the feature models train on real data for now.

**Order of work.**

1. Train baselines 0–4 first. Fit the hybrid only if the tree models leave structured residuals.
2. Pre-training on simulation followed by fine-tuning is allowed, but `trained_on_simulated` must then
   describe the final training data honestly.
3. Validate on held-out real subjects (VALIDATION_PROTOCOL.md).
