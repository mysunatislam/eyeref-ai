# Architecture

```
┌──────────────────────── browser (apps/web, Next.js 16, all on-device) ────────────────────────┐
│ camera (getUserMedia, torch)  ─▶ MediaPipe Face Landmarker (478 pts, iris, blendshapes, pose)   │
│        │ raw frame (never mirrored)            │ eyes, head pose, blink, gaze, iris distance    │
│        ▼                                       ▼                                                │
│ eye crops ─▶ segmentation ─▶ features ─▶ quality model ─▶ estimator (per meridian) ─▶ fusion    │
│               pupil/glint/      crescent,     grade +         physics (crescent +       M/J0/J45 │
│               crescent          gradient,     hard fails      calibrated gradient)      posterior│
│                                 profiles                      | ML (ONNX, future)       gating   │
│                                                                                           │     │
│ IndexedDB (assessments, consented crops)  ◀──────── report + frames + provenance ◀───────┘     │
│ Research / validation / dataset dashboards, vision test (separate from refraction)            │
└───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                            │ explicit, consented, optional
┌──────────────────────── backend (FastAPI, Python reference implementation) ───────────────────┐
│ /api/analyze/frame  /api/estimate  /api/simulate  /api/bench/simulate                          │
│ /api/subjects /sessions /captures /ground-truth /predictions /dataset/export   (SQLite + Fernet)│
│ /api/assistant/explain  (optional Gigalogy Maira, text only, guarded, consent required)       │
└───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                            │ CSV/JSON export
┌──────────────────────── ml/ (research) ───┴──────────────────────────────────────────────────┐
│ synthetic data ─▶ subject/device splits ─▶ baselines ▶ hybrid NN/CNN ─▶ conformal ─▶ ONNX+json │
│ evaluation: MAE/RMSE/±0.25/0.5/1.0, circular axis, Bland–Altman, ROC, rejection, subgroups      │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Design rules

1. **Two implementations, one behaviour.** The Python package `eyeref` is the reference implementation.
   `apps/web/src/lib` is a line-by-line TypeScript twin that runs on the device. Both have unit tests
   for the same invariants. A contract test (`apps/web/src/lib/__tests__/contract.test.ts` →
   `shared/fixtures` → `backend/tests/test_contract.py`) checks that a report produced in the browser
   validates against the backend's pydantic models.
2. **Physics first, learning second.** The `PhotorefractionEstimator` interface has three
   implementations:
   - `PhysicsHeuristicEstimator`, the default;
   - `SimulationOracleEstimator`, used in tests, which refuses real frames;
   - `OnnxMeridionalEstimator`, which refuses real frames when its sidecar says `trained_on_simulated`.

   The learned model predicts a residual on top of the physics prior (`mu = prior + delta`), so it
   cannot drift far from optics without evidence.
3. **Never fabricate.**
   - Rejected frames are never used.
   - Dead-zone frames are intervals, not points.
   - Every number shown to a person has passed the gates in `GatingConfig`.
   - Simulated and real frames cannot be mixed in one report; `buildReport` throws if they are.
4. **Provenance on every prediction.** Each report records the model name and version, the estimator
   kind, the feature-extractor version, the device profile, the calibration version, the app version
   and a timestamp. The database stores the same fields per prediction.
5. **Privacy by default.**
   - Processing happens on the device.
   - Crops are stored only with consent.
   - The server needs research consent before it stores anything, and separate image consent before it
     stores images.
   - Images are encrypted at rest.
   - There is no identity recognition.
   - Third-party AI receives only a de-identified text summary, and only on per-request consent.

## Module map

| Concern | Python (`backend/eyeref`) | TypeScript (`apps/web/src/lib`) |
| --- | --- | --- |
| Power vectors, axis maths | `optics/power_vector.py` | `optics/powerVector.ts` |
| Meridional fit, sampling | `optics/meridional.py` | `optics/meridional.ts` |
| Photorefraction physics | `optics/photorefraction.py` | `optics/photorefraction.ts` |
| Thresholds, accommodation, class probabilities | `optics/classification.py` | `optics/classification.ts` |
| Segmentation / features / quality | `cv/*.py` | `cv/*.ts` |
| Estimators | `inference/estimators.py` | `inference/estimators.ts` |
| Fusion and gating | `inference/fusion.py` | `inference/fusion.ts` |
| Simulator | `simulation/*.py` | `simulation/*.ts` |
| Device profiles | `calibration/device_profiles.py` | `devices.ts` |
| Tracking | (offline only) | `tracking/*` (MediaPipe) |
| Guided protocol | (n/a) | `protocol/*` |

## Hybrid model (ml/eyeref_ml/models/hybrid.py)

- **Inputs.** There are two branches:
  - a 48×48 pupil crop, normalised so the light source points up;
  - the interpretable feature vector plus metadata from `inference/ml_features.py`. The same file
    feeds training and serving.
- **Outputs.** The model has three output heads:
  - `mu = physics_prior + delta`;
  - a heteroscedastic `log σ²`;
  - an auxiliary crescent-side classifier.
- **Eye-level loss.** A differentiable weighted-least-squares fit of the per-meridian predictions gives
  M/J0/J45 losses and a soft class cross-entropy, so the network is trained for the quantity that is
  reported.
- **Uncertainty.** MC dropout at inference, and a split-conformal scale stored in the ONNX sidecar.

## Optional NIR module (FUTURE WORK)

Visible-light photorefraction constricts the pupil and dazzles children. Clinical photoscreeners
(PlusoptiX, Spot) use 850 nm illumination instead. The planned NIR module has these parts:

- **Hardware.** An 850 nm LED ring with segments at several eccentricities and meridians, driven by a
  microcontroller and synchronised to the camera exposure. Phone cameras have NIR-cut filters, so this
  needs a USB UVC camera with no IR-cut filter, or an external module.
- **Advantages.** No pupil constriction, so pupils are larger and the dead zone smaller. Multiple
  eccentricities resolve the dead zone directly, and multiple meridians are captured without rotating
  the device.
- **Software.** It needs nothing new beyond a new `Illumination` value (`nir850`, already in the
  schema), a device profile per segment, and a per-segment source angle. The fusion step already
  handles any set of meridians.
- **Safety.** IEC 62471 photobiological-safety assessment for the LED ring, plus duty-cycle limits.
