# Model training

All commands run from the repository root with the virtualenv created by `make setup`.

```bash
make data       # python -m eyeref_ml.datasets.synthetic --subjects 240 --out data/synthetic --seed 0
make ml-train   # python -m eyeref_ml.training.run_experiments --data data/synthetic --out reports/latest \
                #        --artifacts artifacts --epochs 12 --holdout-device sim-D --publish-web
```

The dataset and every model above are **SIMULATED**. `MANIFEST.json` and the report both say so, and
each exported ONNX sidecar carries `"trained_on_simulated": true`. A sidecar with that flag makes the
serving estimator refuse real frames (`backend/tests/test_inference.py`).

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
- `trained_on_simulated` and the dataset manifest (subjects, frames, seed, devices);
- a metrics summary.

Every prediction stores the model name and version, the extractor version and the calibration version.
To change any input feature, bump `EXTRACTOR_VERSION` in both implementations. Do not mix extractor
versions in training.

## Simulated results and what they teach (SIMULATED DATA)

These are SE mean absolute errors across all test eyes:

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

## Moving to real data

1. Collect paired data (docs/RESEARCH_PROTOCOL.md) and export the CSV from the API.
2. Map the export into the synthetic table format. The columns are the same: `f_*` features, metadata,
   and `gt_*` labels.
3. Train baselines 0–4 first. Fit the hybrid only if the tree models leave structured residuals.
4. Retrain with `trained_on_simulated=false` only on real data.
   - Pre-training on simulation followed by fine-tuning is allowed.
   - The flag must then describe the final training data honestly.
   - The validation must be on held-out real subjects.
