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

## Metrics

`ml/eyeref_ml/evaluation/study.py` computes these from the research server's data (see
[Analysing a study](#analysing-a-study)), and `eye_level.py` computes them for the simulated benchmark.

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

Not yet computed from real data: the quality and gating analysis. It needs every frame, and a rerun
of the estimator without the gate, which the simulated benchmark does.

## Analysing a study

1. Export every eye from the research server: `GET /api/dataset/export?level=eye` (CSV). There is one
   row per eye per visit, with what the product released and the reference refractions measured at
   that visit.
2. Run the analysis:

   ```
   cd ml && python -m eyeref_ml.evaluation.study eyeref_eyes.csv --one-eye --out study.json
   ```

   Or run `make study EXPORT=eyeref_eyes.csv`. Leave out `--one-eye` for the secondary analysis with
   both eyes. The script prints a summary and writes every metric, with its interval, to the JSON file.

How the script applies this protocol:

- **One study.** It refuses an export that mixes simulated and real data. It also refuses results from
  more than one model version unless `--model-version` names the frozen one. A result stored twice for
  the same eye and visit counts once (the later one).
- **Outcomes.** Every eye photographed at a visit is counted. An eye with no result, or with no usable
  frame, is a protocol failure.
- **Reference.** By default this is the autorefractor. `--reference best` takes cycloplegic, then
  subjective, then autorefractor, then retinoscopy, then trial lens. A lensmeter reading is never a
  reference: it measures the spectacles.
- **Agreement** is computed over the eyes given a number. When the reference's |M| exceeds 4 D, both
  sides are compared at the cornea, using the vertex distance recorded with the reference (12 mm if
  none was recorded). Sphere, cylinder and axis are compared only where the gate released them.
- **Screening** counts every eye with a reference. An eye that could not be screened (repeat or
  protocol failure), or that was given no probability, counts as referred and scores 1 on the ROC
  curve. A probability of 0.5 or more is a referral, except for astigmatism, where the product refers
  at 0.7. Hyperopia and astigmatism use the product's age thresholds: +0.50 D and 0.75 D for teenagers
  and adults, +1.50 D and 1.00 D at 8 to 12 years, and +2.00 D and 1.50 D at 3 to 7 years. The product
  gives an astigmatism probability only when at least three meridians gave a quantitative reading, so
  an eye without one counts as referred for astigmatism. Anisometropia is judged per visit, for visits
  with a reference for both eyes. The JSON report has each question's 2x2 table, with how many
  referrals were unscreened eyes (STARD 2015), and its ROC curve.
- **Calibration** compares the myopia, hyperopia and astigmatism probabilities with what the
  reference found, over the screened eyes, at the product's age thresholds. The JSON report has the
  reliability table, by tenth of probability. The summary gives the expected calibration error: the
  mean gap between predicted and observed frequency, weighted by the eyes in each tenth.
- **Subgroups** report the release rate and the SE agreement separately by device, age group,
  refractive range of the reference, pupil size, distance, iris colour, pigmentation and sex. Pupil
  size and distance are the medians over that eye's captures at the visit. The distance bands
  separate the protocol's 1.0 m and 1.5 m. A subgroup that was not collected is left out.
- **Repeatability** uses the released SE of the same eye from separate visits on the same day (UTC).
- **Intervals** are 95% percentile intervals from 2000 resamples of subjects (`--boot`, `--seed`). A
  subject drawn twice counts as two subjects.

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
