# EyeRef AI: status and first steps

## 1. What works today

Verified checks: 98 backend tests, 9 ML tests and 52 web tests pass. Lint, typecheck and the production
build pass. Every page was smoke-tested in Chromium.

- **Optics.** Power vectors, circular axis maths (179° vs 1° = 2°), Bobier–Braddick crescent inversion
  with uncertainty, and the dead zone.
- **On-device pipeline in the browser.**
  - MediaPipe face and iris tracking, head pose, gaze, blink, and distance from iris size.
  - Pupil, glint and crescent segmentation, then features, then a quality grade
    (Excellent / Acceptable / Poor / Reject).
  - A per-meridian physics estimate, then Bayesian M/J0/J45 fusion with 95% intervals.
  - A gated output: quantitative SE, screening only, or repeat.
- **About 20 screens.**
  - Guided capture: profile, preparation and lighting check, distance, live positioning overlays,
    4 device angles, countdown and torch pulse.
  - Analysis and results: processing, report, confidence and "why" panels.
  - History with trends.
  - Research dashboard: raw-crop inspector, heatmap, profiles, meridional fit, axis rose, posteriors,
    frame table.
  - Validation dashboard and dataset collection (Mode 2).
  - Calibration wizard with a dead-zone calculator, vision test (kept separate from refraction), and
    safety page.
- **Research API.**
  - Consent-enforced subjects, sessions, captures, ground truth and predictions.
  - Fernet-encrypted image storage, CSV/JSON export, and model and calibration versions on every
    prediction.
- **Optional Maira explanation.** Credentials come from env vars only. It needs consent on every
  request, sends text only, and a guard strips any refraction number that is not in the report.
- **Contract test.** It proves that a report produced in the browser validates against the backend
  schema.

## 2. What is simulated

- Simulation Mode, which is the default on first launch and is always labelled SIMULATED DATA.
- The synthetic dataset: 240 subjects, 15,360 frames, 4 virtual phones.
- Every model comparison and benchmark, and the gradient gain of 5.78.
- The exported ONNX models. They are flagged `trained_on_simulated` and refuse real eyes.

Two simulated findings matter:

- Tree models matched or beat the neural nets.
- Learned models and their conformal intervals degrade on an unseen phone, so every phone model needs
  its own calibration.

## 3. What needs real data

- **Per phone:** the crescent-side sign check and the gradient-gain bench calibration.
- **Before any accuracy claim:** a learned model trained on real eyes, and validation of SE and of
  myopia/hyperopia screening on people.
- **Last:** CYL/AXIS, which stays gated off.

## 4. The first experiment

**Stage 0: bench.** Use a model eye at 1 m with trial lenses from −4 to +4 D. Confirm:

- the crescent side;
- the dead-zone edges, within 0.25 D of the prediction;
- the gradient gain.

**Stage 1: induced defocus in about 10 corrected adults.**

- Place −2, −1, 0, +1 and +2 D lenses over each person's correction.
- The measured change in M should follow the known change with a slope between 0.8 and 1.2.
- This needs no autorefractor, and it tests the physics on real eyes.

Details: docs/RESEARCH_PROTOCOL.md.

## 5. Collecting the first 100 labelled eyes

- **Sample.** About 50 adults spanning −6 to +3 D, with quotas for myopes, near-emmetropes, hyperopes
  and astigmats.
- **Each visit:**
  1. Consent and a pseudonymous study code.
  2. Remove glasses, dim the room, and wait 60 s.
  3. Run the EyeRef protocol (4 angles × 5 frames at 1.0 m). Then have the person stand and sit, and
     run it again.
  4. Average 3 autorefractor readings, taken within 30 minutes and in randomised order with the EyeRef
     capture.
  5. Enter the reference in the Dataset page.
- **Weekly:** export and check agreement and the rejection rate. Stop and fix the protocol if more than
  40% of captures are rejected.

## 6. Hardware and phone setup

- **Phone and browser.** An Android phone with a rear camera and LED torch, running Chrome. iOS Safari
  cannot control the torch.
- **Mount.** A tripod with a clamp that rotates about the lens, marked at 0°, 45°, 90° and 135°.
- **Distance.** Floor tape at 1.0 m and 1.5 m.
- **Room.** Below about 10 lux.
- **Fixation.** The subject looks at the LED.
- **Bench kit.** Calipers for the flash offset, a ruler for the field of view, a model eye and a trial
  lens set.
- **Serving.** The app must be served over HTTPS, using a tunnel or a reverse proxy.
- **Resolution warning.** Browser video gives only about 9–17 px per pupil at 1 m, so plan the native
  app (apps/mobile).

## 7. Comparing against an autorefractor

- Use the same visit, randomised order and a blinded operator, with a frozen model version.
- Convert both measurements to power vectors.
- Report Bland–Altman bias and 95% limits of agreement for M, and the J0/J45 error.
- Report circular axis error only where the reference |CYL| is 0.75 D or more.
- Report sensitivity, specificity and AUC for myopia and hyperopia.
- Use intention-to-screen: every eye is counted, and the release fraction is reported.
- Bootstrap CIs over subjects.

Details: docs/VALIDATION_PROTOCOL.md.

## 8. What result would be publishable

A STARD-style feasibility paper on about 50 adults that reports, with CIs:

- an induced-defocus slope close to 1, with its repeatability;
- SE limits of agreement against the autorefractor, for example about ±1.0–1.25 D with 60% or more of
  eyes released;
- myopia screening accuracy with every eye counted;
- an honest dead-zone analysis.

Simulated results and cherry-picked captures are not publishable as evidence.

## 9. The path to a medical device

1. Narrow the intended use to referral screening of spherical equivalent by trained staff.
2. Hold an FDA Pre-Submission, which likely leads to a 510(k) or De Novo. In the EU, MDR Rule 11 means
   at least Class IIa.
3. Put the standards in place: ISO 13485, IEC 62304, ISO 14971, IEC 62366 and IEC 62471.
4. Run a pivotal study against cycloplegic or subjective refraction.
5. Plan for a predetermined change control plan for model updates, and calibration per phone model.

Details: docs/REGULATORY_ROADMAP.md.

## 10. Exact commands

```bash
cd eyeref-ai
make setup                 # Python 3.11 venv + npm ci
make test                  # pytest (backend, ml) + vitest (web)
make web                   # http://localhost:3000  (Simulation Mode works without a camera)
make backend               # optional API on :8000 (OpenAPI at /docs)
make data && make ml-train # regenerate SIMULATED dataset, models, validation report
make schemas               # shared/schemas JSON Schemas
cp .env.example .env       # optional; add MAIRA_API_KEY / MAIRA_PROJECT_KEY here, never commit
set -a; . ./.env; set +a; .venv/bin/python scripts/check_maira.py   # one live test call, prints no keys
docker compose up --build  # web :3000 + api :8000
```

To restore the git history: `git clone eyeref-ai.git.bundle eyeref-ai`.
