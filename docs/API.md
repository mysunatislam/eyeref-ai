# Research API (FastAPI)

Run it with `make backend`. The interactive OpenAPI docs are at `http://localhost:8000/docs`.
JSON uses snake_case. The web client converts at `apps/web/src/lib/api.ts`. Keys beginning with an
upper-case letter (`OD`, `OS`, `M`, `J0`, `J45`) are left unchanged.

The API is optional. The web app runs fully on the device without it.

## Meta

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Status and version |
| GET | `/api/models` | Available estimators and their versions (the physics estimator, and the ONNX model if loaded) |
| GET | `/api/devices` | Device profiles |
| POST | `/api/devices` | Add or replace a device profile (`DeviceProfile`) |
| GET | `/api/meta/extractor` | Feature-extractor version |

## Analysis

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/analyze/frame` | multipart: `image` (eye crop PNG/JPEG), `metadata` (JSON `CaptureMetadata`), `iris` (JSON circle), `device_id`, `estimator` | `FrameRecord` (features, quality, estimate) |
| POST | `/api/estimate` | `{frames: [{metadata, features, quality}], device_id, age_group, estimator: physics or ml, gating}` | `AssessmentReport` |
| POST | `/api/simulate` | `{subject_id, age_group, astigmatism_quantification_enabled, frames_per_meridian, meridians}` | **SIMULATED** report, plus ground truth |
| GET | `/api/bench/simulate` | (none) | Simulated bench run: dead-zone edges, feature monotonicity, gradient fit |

`estimator=ml` returns `insufficient` for real frames until a model trained on real data is installed
(`EYEREF_MODEL_PATH`).

## Dataset (Mode 2)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/subjects` | `{code, age_group, consent_research, consent_image_storage, ...}`. Returns **403 without `consent_research`** and 409 for a duplicate code |
| GET | `/api/subjects` | List |
| DELETE | `/api/subjects/{id}` | Cascading delete, including the stored images |
| POST | `/api/subjects/{id}/ground-truth` | `{eye, method, sphere, cylinder, axis, vertex_distance_mm, instrument, examiner, raw}`. Stored in minus cylinder |
| POST | `/api/sessions` | `{subject_id, device_id, protocol_version, cycloplegia, condition_label, simulated, ...}` |
| POST | `/api/sessions/{id}/captures` | multipart: `metadata`, `features`, `quality`, optional `image`. The image is refused with 403 without image consent, and is encrypted at rest when `EYEREF_STORAGE_KEY` is set |
| POST | `/api/sessions/{id}/predictions` | `AssessmentReport`. Stores one row per eye with model, extractor and calibration versions |
| GET | `/api/dataset/export?fmt=csv\|json&include_simulated=false` | One row per capture, with flattened features and the ground truth per method |

## Optional AI explanation

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/assistant/status` | `{configured, provider, label}` |
| POST | `/api/assistant/explain` | `{report, question?, consent_third_party}`. Possible responses: 503 if the assistant is not configured, 403 without consent, 502 if the upstream call fails, or `{text, redactions, provider, label}` |

**Provider.** The assistant uses Gigalogy Maira (`POST {MAIRA_BASE_URL}/v1/maira/ask`, headers
`api-key` and `project-key`). Credentials come **only** from the environment variables
`MAIRA_API_KEY`, `MAIRA_PROJECT_KEY`, `MAIRA_BASE_URL`, `MAIRA_GPT_PROFILE_ID` and `MAIRA_TIMEOUT_S`.

**What is sent.** A de-identified text summary of the existing report: output levels, classes, SE
values and intervals that are already shown, and notes. No images, no profile label, and an anonymous
user id.

**Guard.** `eyeref/assistant/guard.py` redacts any dioptre value, axis or prescription-style field
that is not in the report, and neutralises phrases like "your prescription is". The assistant can
never create SPH/CYL/AXIS values.

## Environment

See `.env.example`. The variables are:

- `EYEREF_DATA_DIR`
- `EYEREF_DATABASE_URL`
- `EYEREF_STORAGE_KEY` (a Fernet key)
- `EYEREF_MODEL_PATH`
- `EYEREF_CORS_ORIGINS`
- `MAIRA_*`
