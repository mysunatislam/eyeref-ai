# EyeRef AI

**Attachment-free smartphone / webcam eccentric-photorefraction research prototype.**

> ⚠️ Experimental research software. It is **not a medical device** and it does **not** produce eyeglass
> prescriptions. All performance numbers in this repository come from **SIMULATED DATA** and are not
> evidence of clinical accuracy. See [docs/MEDICAL_LIMITATIONS.md](docs/MEDICAL_LIMITATIONS.md).

EyeRef uses a camera and the light source next to its lens (phone torch / flash, or a small LED on a
development rig) to perform **eccentric photorefraction**. Light reflected from the retina forms a bright
crescent in the pupil whose side and width depend on the eye's defocus relative to the camera. EyeRef:

1. tracks the face and irises on-device (MediaPipe Face Landmarker; no identity recognition),
2. segments pupil, corneal glint and crescent in each eye crop from the **raw** (non-mirrored) frame,
3. grades every frame (blur, glare, blink, gaze, motion, pupil size, distance, illumination), rejecting bad ones,
4. inverts the crescent with the Bobier–Braddick model per **meridian** (one meridian per device rotation),
5. fits a Bayesian **power vector (M, J0, J45)**, so axis is never regressed as a raw 0–180° number,
6. propagates uncertainty (Monte Carlo, accommodation, calibration and temporal noise) to 95% intervals, and
7. **gates** the output: *quantitative SE* → *screening only* → *repeat / insufficient confidence*.

It never invents SPH/CYL/AXIS. CYL/AXIS display is **off by default** until validated on controlled
multi-meridian data. The development order is spherical equivalent and myopia/hyperopia screening
first, then astigmatism later.

## Two modes

| Mode | Purpose |
| --- | --- |
| **Mode 1 · Camera research mode** | Guided capture → on-device pipeline → gated report. Physics estimator only. |
| **Mode 2 · Hybrid validation / dataset collection** | Same capture, plus pseudonymous subject codes, reference refraction entry (autorefractor, subjective, cycloplegic), local agreement stats, CSV export, and consented upload to the research API. |
| **Simulation Mode** (default on first launch) | Renders virtual eyes with known refraction and runs the **real** pipeline on them. Everything is labelled **SIMULATED DATA**. |

## Status matrix

| Component | Status | Notes |
| --- | --- | --- |
| Power-vector maths, circular axis handling (179° vs 1° = 2°), transposition, mirroring | **WORKING** | Unit-tested in Python and TypeScript |
| Eccentric photorefraction physics (dead zone, crescent width, inversion with uncertainty) | **WORKING** | Crescent-side sign convention must be verified on the bench (`CRESCENT_SAME_SIDE_FOR_MYOPIC`) |
| Face/iris tracking, head pose, gaze, blink, iris-based distance | **WORKING** | MediaPipe in-browser; not yet tested on a diverse population |
| Pupil / glint / crescent segmentation | **PARTIALLY WORKING** | Robust on rendered eyes; real-camera robustness unmeasured. Browser video gives only about 9–17 px per pupil at 1 m |
| Frame quality model (Excellent / Acceptable / Poor / Reject) | **WORKING** | Thresholds are engineering choices; need tuning on real captures |
| Bayesian M/J0/J45 fusion, gating, anisometropia, reflex asymmetry | **WORKING** | Gating limits are configurable (`GatingConfig`) |
| Guided capture UI (lighting, distance, positioning, 4 meridians, torch pulses, countdown, overlays) | **WORKING** | Torch control needs Chrome on Android; iOS Safari has no torch API |
| Device rotation (meridian) from the tilt sensor | **PARTIALLY WORKING** | Sign convention for a rear camera aimed at a subject must be bench-verified |
| Printable referral report (one A4 page, or save as PDF) | **WORKING** | Gated output only: never prints SPH/CYL/AXIS. Simulated data is watermarked. A browser test checks that it fits one page in light colours |
| Encrypted backup and restore of on-device history | **WORKING** | AES-256-GCM with a passphrase key (PBKDF2-SHA-256, 600,000 iterations), entirely in the browser. Restore never overwrites and rejects records that mix simulated and real data |
| On-device data care: eye-image retention, storage protection, backup reminder | **WORKING** | Eye images can be deleted on their own or expire after 7, 30 or 90 days, keeping results; the limit covers records from older versions too and is applied each time the app opens. The browser is asked to keep the data only when the user taps the button |
| Simulation Mode, simulator, synthetic dataset | **SIMULATED** | Always labelled |
| Model comparison (physics, ridge, poly, RF, GBM, hybrid NN, hybrid CNN), conformal intervals, subject-level and leave-device-out splits | **SIMULATED** | Trained and evaluated on synthetic data only |
| Learned estimator for real eyes | **REQUIRES TRAINING DATA** | Exported ONNX models are tagged `trained_on_simulated` and **refuse** real frames |
| Dead-zone gradient gain per device | **REQUIRES TRAINING DATA** | Needs a bench calibration with trial lenses (docs/DEVICE_CALIBRATION.md) |
| SE accuracy, myopia/hyperopia screening on real people | **REQUIRES CLINICAL VALIDATION** | Protocol in docs/VALIDATION_PROTOCOL.md |
| CYL / AXIS output | **REQUIRES CLINICAL VALIDATION** | Gated off; research flag only |
| Research API, encrypted image storage, dataset export, consent enforcement | **WORKING** | Bearer-token access control (required when `EYEREF_ENV=production`), Fernet at rest. SQLite or PostgreSQL, both tested in CI. Versioned migrations upgrade the database on start and keep its data |
| Optional AI explanation (local Gemma via Ollama by default; Gigalogy Maira optional) | **PARTIALLY WORKING** | Text-only summary, numeric guard tested against prescription-leaking replies, consent required for any remote provider. Verified against mocks only, because model downloads are blocked in the build sandbox. Run `scripts/check_assistant.py` once on your machine |
| Error recovery: crash pages, update prompt, unreadable records | **WORKING** | A failed page offers a retry without losing stored data, a new version offers a reload, and records the app cannot read are counted instead of hiding the rest |
| Installable app (PWA) with offline use | **WORKING** | Manifest, icons and a service worker that caches app code and the MediaPipe model, never results or camera frames. Verified offline in Chromium. Needs HTTPS to install |
| Continuous integration | **WORKING** | `.github/workflows/ci.yml`: ruff, pytest, eslint, prettier, tsc, vitest, production build, web/backend contract. Runs on the first push |
| Vision test (tumbling E logMAR, astigmatic dial) | **WORKING** | Separate from refraction; needs screen calibration |
| Native mobile app (RAW stills, manual focus, flash sync) | **FUTURE WORK** | apps/mobile/README.md |
| NIR (850 nm) illumination module | **FUTURE WORK** | docs/ARCHITECTURE.md § NIR |

## Simulated benchmark (SIMULATED DATA)

There are 240 virtual subjects and 15,360 frames, rendered as 4 simulated phones. The test set is
split by subject. Spherical-equivalent mean absolute error across all test eyes, using the ungated
posterior:

| Model | Subject split | Unseen device (sim-D) |
| --- | --- | --- |
| Physics only | 0.54 D | 0.69 D |
| Ridge | 0.24 D | 0.54 D |
| Polynomial ridge | **0.16 D** | 0.98 D |
| Random forest | 0.17 D | **0.21 D** |
| Gradient boosting | 0.17 D | 0.23 D |
| Hybrid NN (features + physics prior) | 0.17 D | 0.38 D |
| Hybrid CNN (crop + features) | 0.17 D | 0.41 D |

**Findings**

- Deep learning did **not** beat tree ensembles on simulated data.
- Learned models lose more on an unseen device than they gain in-distribution.
- Conformal 95% intervals that were calibrated on seen devices under-cover on a new device. Coverage
  drops to 57–86% for the linear and NN models.

The practical consequence is that every phone model needs its own calibration. These numbers only show
that the pipeline is self-consistent.

## Quick start

```bash
# prerequisites: Python 3.11, Node 22
make setup            # .venv with backend + ML deps, npm ci for the web app
make test             # backend (pytest), ML (pytest), web (vitest)
make web              # http://localhost:3000  (Simulation Mode works with no camera)
make backend          # optional research API on http://localhost:8000 (docs at /docs)

# regenerate everything that is simulated
make data             # 240 virtual subjects -> ml/data/synthetic (SIMULATED)
make ml-train         # baselines + hybrid models, validation report, ONNX export, publish to the web app
make schemas          # JSON Schemas of the shared contracts -> shared/schemas

# containers
cp .env.example .env  # optional settings; never commit .env
docker compose up --build
```

The camera needs HTTPS or `localhost`. To test on a phone, serve the web app over HTTPS, for example
with a tunnel or a TLS reverse proxy. Then open it in **Chrome on Android**, which allows torch
control.

## Repository layout

```
apps/web/        Next.js 16 app: on-device CV pipeline (TypeScript twin of the backend), guided capture, dashboards
apps/mobile/     native app plan (FUTURE WORK)
backend/eyeref/  reference implementation (Python): optics, CV, quality, estimators, fusion, simulation,
                 calibration, research bench, FastAPI research API, encrypted storage, optional AI assistant
ml/eyeref_ml/    datasets, augmentations, splits, baselines, hybrid model, training, evaluation, conformal, ONNX export
shared/          JSON Schemas and cross-language fixtures (browser report validated by the backend)
docs/            science, data, validation, regulatory and calibration documentation
scripts/         export_schemas.py, run-all.sh
```

## Documentation

- [ARCHITECTURE](docs/ARCHITECTURE.md): system design, data flow, the NIR option
- [PHOTOREFRACTION](docs/PHOTOREFRACTION.md): the optics, the dead zone, and why distance and pupil size matter
- [DATASET](docs/DATASET.md): schema, investigator workflow, augmentations
- [MODEL_TRAINING](docs/MODEL_TRAINING.md): baselines, the hybrid model, splits, versioning
- [VALIDATION_PROTOCOL](docs/VALIDATION_PROTOCOL.md): metrics, comparison against an autorefractor, sample size
- [RESEARCH_PROTOCOL](docs/RESEARCH_PROTOCOL.md): the first 100 labelled eyes, step by step
- [DEVICE_CALIBRATION](docs/DEVICE_CALIBRATION.md): geometry, FOV, the gradient-gain bench
- [MEDICAL_LIMITATIONS](docs/MEDICAL_LIMITATIONS.md)
- [REGULATORY_ROADMAP](docs/REGULATORY_ROADMAP.md)
- [API](docs/API.md)

## Privacy

- Analysis happens on the device. Nothing is uploaded unless an investigator uploads a consented record.
- Landmarks are used only for geometry. There is no face recognition.
- Eye crops are stored locally only with consent. History can delete them on their own, keeping the
  results, or remove them automatically once they are 7, 30 or 90 days old.
- Plain JSON exports leave eye images out. A backup keeps them only inside a file encrypted on the
  device with the user's passphrase, which EyeRef never sees.
- The server refuses to store data without research consent, and refuses images without separate
  image consent. It encrypts images at rest when `EYEREF_STORAGE_KEY` is set.
- Credentials come only from environment variables. Never commit `.env` or key files.

## Security

- **No third-party requests at runtime.** The MediaPipe runtime and face model are served by the app
  itself. The build fetches the model and checks its SHA-256 (`apps/web/scripts/fetch-models.mjs`). A
  browser test fails if any request leaves the app's own origin.
- **Content Security Policy.** The web app may connect only to itself and the research backend it was
  built for (`NEXT_PUBLIC_API_URL`, plus `EYEREF_CSP_CONNECT_SRC`). There are no plugins and no
  framing.
- **Research API.** Bearer tokens are required in production, along with encrypted image storage, and
  the interactive docs are hidden. See [API](docs/API.md#authentication).
- **Checks on every push.** Unit tests, browser tests including camera mode with a fake camera, and a
  WCAG 2.1 AA accessibility scan in light and dark mode.

## Releasing

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The tag runs the full CI suite. It then publishes `ghcr.io/mysunatislam/eyeref-ai-api` and
`ghcr.io/mysunatislam/eyeref-ai-web`, and creates a GitHub release with generated notes.

- The web image is built for a backend at `http://localhost:8000`. For a hosted deployment, build it
  with your own `NEXT_PUBLIC_API_URL`, because the security policy is fixed at build time.
- Dependabot opens grouped update PRs every week for npm and pip, and every month for Actions and base
  images.
