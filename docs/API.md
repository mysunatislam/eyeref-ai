# Research API (FastAPI)

Run it with `make backend`. The interactive OpenAPI docs are at `http://localhost:8000/docs`.
JSON uses snake_case. The web client converts at `apps/web/src/lib/api.ts`. Keys beginning with an
upper-case letter (`OD`, `OS`, `M`, `J0`, `J45`) are left unchanged.

The API is optional. The web app runs fully on the device without it.

## Authentication

The API stores pseudonymous health data, so it is locked with bearer tokens once they are configured:

```bash
export EYEREF_API_TOKENS="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export EYEREF_STORAGE_KEY="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
export EYEREF_ENV=production   # refuse to start without tokens or an image-encryption key, hide /docs
```

- Every request except the public list below needs `Authorization: Bearer <token>`. Otherwise it gets
  401 with `WWW-Authenticate: Bearer`.
- Public: `GET /health`, `GET /api/models`, `GET /api/devices`, `GET /api/meta/extractor`,
  `GET /api/assistant/status`, and CORS preflight requests.
- Several comma-separated tokens can be active at once, so a token can be rotated without downtime.
  Tokens shorter than 24 characters are refused at startup.
- Tokens are compared in constant time and never appear in logs or in the config's repr. The
  [audit log](#audit-log) names each caller by the token's fingerprint instead.
- In the web app, paste the token under Calibration → App settings. It is stored on that device only.
- With no tokens in development (the default), auth is off and `/health` reports `"auth": "disabled"`.

## Limits

- Request bodies over 10 MB are refused with 413, whether the size is declared or streamed. Set
  `EYEREF_MAX_BODY_BYTES` to change it.
- Uploaded eye crops must be at most 2 MB and 16 megapixels. The size is read from the file header
  before anything is decoded, so a small file that claims huge dimensions is refused with 413.
- `/api/analyze/frame` accepts PNG or JPEG. Stored captures accept PNG only, so the stored image is
  lossless. Anything else gets 415.

## Meta

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Status and version |
| GET | `/api/models` | Available estimators and their versions (the physics estimator, and the ONNX model if loaded) |
| GET | `/api/devices` | Device profiles |
| POST | `/api/devices` | Add or replace a device profile (`DeviceProfile`). The id is up to 64 letters, digits, `.`, `_` or `-`, because it names the profile's file |
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

**Uploading a record.** The web app sends each record with one request, which stores all of it or
nothing:

```
POST /api/assessments   multipart: record (JSON), images (PNG eye crops, repeated)
record = {client_ref, subject: {code, age_group, consent_research, consent_image_storage, ...},
          ground_truth: [...], session: {device_id, protocol_version, simulated, ...},
          device: DeviceProfile | null, captures: [{metadata, features, quality, image}], report}
```

- **All or nothing.** The subject, reference refractions, session, captures, eye crops and the
  report's predictions are stored in one transaction. If anything is refused or fails, nothing is
  kept, including any image already written. Every image is checked before any is stored.
- **Safe to send again.** `client_ref` is the record's id on the device. A record that is already
  stored answers 200 with `already_uploaded: true` and what was stored, and stores nothing twice, even
  when two copies arrive at the same moment. A new record answers 201.
- **Returning participants.** A subject code that already exists gets another session rather than
  a 409, so test-retest visits work. Image consent given at a later visit is recorded on the subject.
- **Consent.** 403 without `consent_research`, and 403 if images are sent without
  `consent_image_storage`. Each image must belong to exactly one capture (`image` is its index).
- **No mixing.** The session, every capture and the report must agree on `simulated`, and the report
  must come from the session's device profile (422 otherwise).
- **Custom phones.** A device profile the server does not know is registered from `device` (404 if
  it is missing). A known profile is never replaced by an upload; use `POST /api/devices` for that.
- The whole request must fit the body limit (10 MB by default, `EYEREF_MAX_BODY_BYTES`).

The step-by-step endpoints below remain for scripts and other clients.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/assessments` | One record, all or nothing, as above |
| POST | `/api/subjects` | `{code, age_group, consent_research, consent_image_storage, ...}`. Returns **403 without `consent_research`** and 409 for a duplicate code |
| GET | `/api/subjects` | List |
| DELETE | `/api/subjects/{id}` | Cascading delete, including the stored images |
| POST | `/api/subjects/{id}/ground-truth` | `{eye, method, sphere, cylinder, axis, vertex_distance_mm, instrument, examiner, raw}`. Stored in minus cylinder |
| POST | `/api/sessions` | `{subject_id, device_id, protocol_version, cycloplegia, condition_label, simulated, ...}` |
| POST | `/api/sessions/{id}/captures` | multipart: `metadata`, `features`, `quality`, optional `image` (PNG). The image is refused with 403 without image consent, is stored once per capture, and is encrypted at rest when `EYEREF_STORAGE_KEY` is set |
| POST | `/api/sessions/{id}/predictions` | `AssessmentReport`. Stores one row per eye with model, extractor and calibration versions |
| GET | `/api/dataset/export?fmt=csv\|json&include_simulated=false` | One row per capture, with flattened features and the ground truth per method |

## Audit log

Every change to research data, and every read or export of it, adds an event to the audit log in the
same transaction as the action, so the two are saved together or not at all. An export is sent only
after its event is saved. A refused request (no consent, a duplicate code, an unknown id) changes
nothing and records nothing.

| Action | Recorded when | Details |
| --- | --- | --- |
| `subject.create` | A subject is enrolled | Research and image consent, consent version |
| `subject.list` | The subject list is read | Number of subjects |
| `subject.delete` | A subject and all their data are deleted | Number of images deleted |
| `ground_truth.add` | A reference refraction is added | Its id, the eye, the method |
| `session.create` | A capture session starts | Its id, the device profile, whether it is simulated |
| `capture.add` | A capture is stored | Its id, the session, the eye, whether an image was stored |
| `prediction.add` | A report's results are stored | The session, the new prediction ids |
| `assessment.upload` | A whole record is uploaded | The session; how many reference refractions, captures and images; the prediction ids |
| `subject.consent` | A returning subject gives image consent | The consent version |
| `dataset.export` | The dataset is exported | Format, rows, subjects, whether simulated data was included |
| `device.save` | A device profile is added or replaced | Its id and calibration version |

- **Who.** `actor` is the fingerprint of the API token that was used: `tok_` and the first 12 hex
  digits of the token's SHA-256. The token itself is never stored. With auth off, `actor` is
  `anonymous`. To find which token a fingerprint belongs to:
  `python -c "import hashlib, sys; print('tok_' + hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])" "$TOKEN"`.
- **No personal data.** Events hold ids, counts and flags: no subject codes, measurements, notes or
  images. The trail is therefore kept when a subject is deleted, and still shows what happened to them.
- **Reading it.** `GET /api/audit?subject_id=&action=&before=&limit=` returns `{events, next_before}`,
  newest first. Each event is `{id, at, actor, action, subject_id, details}`, with `at` in UTC.
  `limit` is 1 to 1000 (default 100). To get the next page, pass `next_before` as `before`; it is
  `null` on the last page. Like every data endpoint, it needs a token.
- A request with a missing or wrong token gets 401 before it reaches the API, so it appears in the
  server's access log rather than the audit log.

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

## Database

The API stores research data in SQLite by default, or in PostgreSQL when `EYEREF_DATABASE_URL`
names one, for example `postgresql+psycopg://user:password@host:5432/eyeref`. Both are tested in CI.
SQLite suits a single API process; use PostgreSQL to run several.

**Upgrades.** The schema is versioned with Alembic migrations in `backend/eyeref/db/migrations`. The
API applies pending migrations when it starts, so a new version upgrades the database it finds and
keeps the data. Replicas that start together on PostgreSQL take turns behind a lock. A database made
before migrations existed is recognised and adopted with its data. To migrate as a separate release
step instead, run `python -m eyeref.db upgrade` (or `alembic upgrade head` from `backend/`) before
starting the new version.

**Rolling back.** An older version refuses to start on a database that a newer version has already
migrated, and says so, rather than touching data it does not understand. Back up the database before
upgrading if you may need to go back.

**Changing the schema.** Edit `backend/eyeref/db/models.py`, then from `backend/` run
`alembic revision --autogenerate -m "what changed"` and review the generated file. A test fails
whenever the models and the migrations disagree, so a model change cannot ship without its migration.
SQLite alters a table by rebuilding it, so foreign keys are switched off while migrating (otherwise
rebuilding `subjects` would delete every session that refers to it) and checked once at the end.

## Environment

See `.env.example`. The variables are:

- `EYEREF_DATA_DIR`
- `EYEREF_DATABASE_URL`
- `EYEREF_STORAGE_KEY` (a Fernet key)
- `EYEREF_MODEL_PATH`
- `EYEREF_CORS_ORIGINS`
- `EYEREF_ENV` (`development` or `production`)
- `EYEREF_API_TOKENS` (comma-separated bearer tokens)
- `EYEREF_MAX_BODY_BYTES` (default 10 MB)
- `MAIRA_*`
