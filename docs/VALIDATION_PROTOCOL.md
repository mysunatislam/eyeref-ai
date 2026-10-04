# Validation protocol

## Comparison against an autorefractor

**Pairing.**

- Do the EyeRef capture and the reference measurement in the same visit, within 30 minutes, in the
  same room, with randomised order.
- Average three autorefractor readings.
- Record the instrument model and the vertex distance.

**Representation.** Convert both the reference and EyeRef to power vectors (M, J0, J45). The reference
is usually reported at the spectacle plane (12 mm vertex). For |M| > 4 D, convert both to the corneal
plane before comparing.

**Blinding.** The person entering the reference data does not see the EyeRef output. The EyeRef model
version is frozen before the study starts, and its version string is recorded in every prediction.

**Intention to screen.** Report every eye that entered the protocol. Results fall into four groups:

- *quantitative*: a number was released;
- *screening only*: a class was released, but no number;
- *repeat*: nothing was released;
- *protocol failure*: no usable capture.

Accuracy is reported **within** the released set, **and** coverage (the fraction released) is
reported. A method that releases 30% of eyes with excellent accuracy is a different product from one
that releases 90%.

## Metrics (all implemented in `ml/eyeref_ml/evaluation`)

| Quantity | Metrics |
| --- | --- |
| SE / M | MAE, RMSE, bias, % within ±0.25 / ±0.50 / ±1.00 D, Pearson r, **Bland–Altman** bias and 95% limits of agreement, proportional-bias slope |
| Sphere, cylinder | MAE, % within thresholds (cylinder only when the gate allows) |
| J0, J45 | MAE, bias, LoA |
| Axis | **Circular** error (179° vs 1° = 2°), only for eyes with reference \|CYL\| ≥ 0.75 D: mean, median, % within 5°/10°/20° |
| Screening | Sensitivity, specificity, PPV, NPV, ROC AUC (with ROC curve) for myopia (SE ≤ −0.5 D adults), hyperopia (SE ≥ +0.5 D adults; age-specific thresholds for children), astigmatism (\|CYL\| ≥ 0.75/1.0/1.5 D), **anisometropia** (\|ΔSE\| ≥ 1.0 D) |
| Uncertainty | Empirical coverage of the 95% intervals, interval width, calibration plot |
| Quality / gating | Rejection rate by grade, MAE if rejected frames had been used (justifies the gate), selective-prediction curve |
| Repeatability | ICC(1,1), within-subject SD, coefficient of repeatability (2.77 × Sw) from repeated captures |
| Subgroups | Device, age band, refractive range, pupil size, distance, iris colour / skin tone, sex if collected |

Report 95% confidence intervals for every metric. Use bootstrap resampling over **subjects**, not over
eyes or frames.

## Generalisation tests

- **Subject-level** splits only. No person is in both training and test.
- **Leave-one-device-out.** Report the change in MAE and in interval coverage. The simulation shows that
  coverage can collapse on a new device, so recalibrate the conformal scale per device.
- **Leave-one-site-out**, once more than one site is collecting.
- **Distance** robustness: 1.0 m against 1.5 m.

## Sample size

- **Agreement.** The 95% CI half-width of a limit of agreement is about 1.96·√(3/n)·s. With s = 0.6 D
  and n = 100 independent eyes, that is about ±0.20 D, which is adequate for a first report. Use one
  eye per person, or a mixed model.
- **Screening.** To estimate a sensitivity of 0.85 with a 95% CI of ±0.08, you need about 77 cases with
  the condition. For myopia, at about 40% prevalence in a young adult sample, that means about 200
  people. Plan stage 2 (100 eyes) as a feasibility study and a later stage as the screening-accuracy
  study.

## What result would be publishable

A first paper (feasibility, adults, autorefractor reference, n ≈ 50 people or 100 eyes) is credible
and publishable in an optometry or ophthalmic-technology journal if it reports, with CIs, all of the
following:

1. **Physics validity in vivo.** The induced-defocus slope is close to 1, with repeatability given as
   ICC and Sw (stage 1).
2. **Agreement for released eyes.** SE bias and 95% LoA against the autorefractor, together with the
   release fraction. A phone with no attachment achieving **LoA of about ±1.0–1.25 D, with 60% or more
   of eyes released**, would be a meaningful result. Published commercial photoscreeners commonly report
   limits of agreement of roughly ±1 D or wider against cycloplegic refraction.
3. **Screening accuracy** for myopia of −0.5 D or worse and −1.0 D or worse: sensitivity, specificity
   and AUC, with every eye counted (screening and repeat outcomes included).
4. **The dead-zone analysis.** How often emmetropes and low myopes fall in the dead zone at 1.0 and
   1.5 m, and how much the calibrated gradient helps. This is a useful negative or limits result even
   if accuracy is modest.
5. **Failure modes** by subgroup: pupil size, iris colour, age.

Not publishable as evidence of accuracy:

- any result on simulated data;
- results with subject leakage between training and test;
- accuracy reported only on hand-picked good captures;
- a CYL/AXIS claim without at least 3 measured meridians and an astigmatic stratum.

Pre-register the analysis, for example on OSF, and follow STARD 2015 for diagnostic-accuracy reporting.
