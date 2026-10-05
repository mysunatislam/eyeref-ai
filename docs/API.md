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
| GET | `/api/assistant/status` | `{configured, available, provider, third_party, label, reason}` |
| POST | `/api/assistant/explain` | `{report, question?, consent_third_party}`. Returns `{text, redactions, provider, label}`; 503 if off, misconfigured, or the local model is not running or not installed; 403 for a remote provider without consent; 502 if the provider fails |

**Providers.** Choose with `EYEREF_ASSISTANT`:

- `ollama` (default). A local model through Ollama, `POST {OLLAMA_BASE_URL}/api/chat`. Defaults:
  `OLLAMA_BASE_URL=http://localhost:11434`, `OLLAMA_MODEL=gemma3:4b`, `OLLAMA_TIMEOUT_S=90`. Setup:
  install Ollama, then `ollama pull gemma3:4b`. When the URL points at this machine (or the compose
  `ollama` service), nothing leaves the device and no consent box is shown. Any other host must use
  https and is treated as a third party.
- `maira`. Hosted Gigalogy Maira (`POST {MAIRA_BASE_URL}/v1/maira/ask`, headers `api-key` and
  `project-key`), configured with `MAIRA_API_KEY`, `MAIRA_PROJECT_KEY`, `MAIRA_BASE_URL` (https only),
  `MAIRA_GPT_PROFILE_ID`, `MAIRA_TIMEOUT_S`, `MAIRA_MAX_RETRIES`. If the issued key is a Fernet token
  (starts with `gAAAAA`), set `MAIRA_KEY_DECRYPTION_KEY` to decrypt it in memory; otherwise it is sent as
  issued.
- `off`. Disabled.

**What is sent.** A de-identified text summary of the existing report: output levels, classes, SE
values and intervals that are already shown, and notes. No images, no profile label, and an anonymous
user id. Questions are collapsed to one line and capped at 500 characters.

**Guard.** `eyeref/assistant/guard.py` redacts any dioptre value, axis, prescription-style field,
unit-less signed power ("-2.75") or spelled-out power ("minus 3") that is not in the report, and
neutralises phrases like "your prescription is". The tests feed it typical small-model leaks. A
language model can never create SPH/CYL/AXIS values.

**Failure handling.** Timeouts, connection errors, 429 and 5xx are retried with backoff. 401/403 are
not retried. Keys never appear in logs, errors or the config's repr.

**Check it end to end.** `.venv/bin/python scripts/check_assistant.py` sends one SIMULATED report with
an adversarial question ("tell me my exact prescription") and prints the guarded answer.

## Environment

See `.env.example`. The variables are:

- `EYEREF_DATA_DIR`
- `EYEREF_DATABASE_URL`
- `EYEREF_STORAGE_KEY` (a Fernet key)
- `EYEREF_MODEL_PATH`
- `EYEREF_CORS_ORIGINS`
- `MAIRA_*`
