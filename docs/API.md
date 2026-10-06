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
  Tokens shorter than 24 characters are refused at startup, and so is a token listed twice.
- Tokens are compared in constant time and never appear in logs or in the config's repr. The
  [audit log](#audit-log) names each caller by the token's fingerprint instead.
- In the web app, paste the token under Calibration → App settings. It is stored on that device only.
  **Check access**, under it, asks the server what the token may do.
- With no tokens in development (the default), auth is off and `/health` reports `"auth": "disabled"`.

### Roles

Each token has a role, so a capture phone that is lost or shared gives away as little as possible.
Write the role before the token; a token without one is an admin token, as every token was before
roles existed:

```bash
EYEREF_API_TOKENS="collect:<phone token>,analyse:<analyst token>,admin:<administrator token>"
```

| Role | For | May call, besides the public endpoints |
| --- | --- | --- |
| `collect` | Capture phones | `POST /api/assessments`, `POST /api/subjects`, `POST /api/subjects/{id}/ground-truth`, `POST /api/sessions`, `POST /api/sessions/{id}/captures`, `POST /api/sessions/{id}/predictions`. It cannot read any research data back. An upload can add the profile of a phone the server does not know yet, but never replaces one it has. |
| `analyse` | Whoever analyses the study | `GET /api/subjects`, `GET /api/dataset/export`. It cannot add, change or delete anything. |
| `admin` | The study's administrator | Every endpoint. Only an admin may read a participant's whole record (`GET /api/subjects/{id}`), withdraw their image consent (`DELETE /api/subjects/{id}/images`), delete a subject (`DELETE /api/subjects/{id}`), add or replace a device profile (`POST /api/devices`), or read the [audit log](#audit-log). |

- Every role may call the endpoints that compute on what the request brings and store nothing
  (`/api/analyze/frame`, `/api/estimate`, `/api/simulate`, `/api/bench/simulate`,
  `/api/assistant/explain`), and `GET /api/access`.
- A request the token's role does not allow gets 403, with the role and a sentence saying what the
  token is for: `{"detail": "This API token is for adding research data, so it cannot do this. Ask the study's administrator for a token that can.", "role": "collect"}`.
  Like a 401, it is refused before it reaches the API, so nothing is stored or audited.
- An endpoint added later is admin-only until it is given to a role in `ROLE_ENDPOINTS`
  (`backend/eyeref/api/auth.py`). A test fails if any endpoint is neither public nor decided.
- An unknown role (`colect:...`) stops the server at startup with the list of roles.
- `GET /api/access` returns what the caller's token may do: `{"auth": "token", "role": "collect", "token": "tok_0123456789ab"}`,
  where `token` is the fingerprint the audit log uses. With auth off it returns
  `{"auth": "disabled", "role": "admin", "token": null}`.

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
| GET | `/api/access` | What the caller's token may do: its [role](#roles) and fingerprint |
| GET | `/api/models` | Available estimators and their versions (the physics estimator, and the ONNX model if loaded) |
| GET | `/api/devices` | Device profiles |
| POST | `/api/devices` | Add or replace a device profile (`DeviceProfile`). The id is up to 64 letters, digits, `.`, `_` or `-`, because it names the profile's file |
| GET | `/api/meta/extractor` | Feature-extractor version |

## Analysis

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/analyze/frame` | multipart: `image` (eye crop PNG/JPEG), `metadata` (JSON `CaptureMetadata`), `iris` (JSON circle), `device_id`, `estimator` | `FrameRecord` (features, quality, estimate) |
| POST | `/api/estimate` | `{frames: [{metadata, features, quality}], device_id, age_group, estimator: physics or ml, gating, focus_model}` | `AssessmentReport` |
| POST | `/api/simulate` | `{subject_id, age_group, astigmatism_quantification_enabled, frames_per_meridian, meridians}` | **SIMULATED** report, plus ground truth |
| GET | `/api/bench/simulate` | (none) | Simulated bench run: dead-zone edges, feature monotonicity, gradient fit |

`estimator=ml` returns `insufficient` for real frames until a model trained on real data is installed
(`EYEREF_MODEL_PATH`).

`focus_model` allows for the eyes focusing on the light (docs/PHOTOREFRACTION.md §5). Left out, it is on for
`physics` and off for `ml`, whose model learned from static targets; send `false` for a capture through a
stage 1 trial lens. When it is on, the report's `focus` gives the light's vergence, the age's focusing
amplitude and how likely it is that the eyes focused. Each measured eye then carries `refraction_range95`,
the 95% range of its own refraction, and an eye with a crescent whose range reaches 1 D or more past the
top of its reading's interval comes back with `focus_limited: true` and no `se_d`.

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
- **One visit.** The reference refractions sent with a record belong to its session, and are paired
  only with that session's captures. The session is dated by its first capture, not by the upload.
- **Consent.** 403 without `consent_research`, and 403 if images are sent without
  `consent_image_storage`. Each image must belong to exactly one capture (`image` is its index).
  After a participant [withdraws image consent](#participants-data), a record of a visit that began
  before the withdrawal gets 403 if it carries images (send it again without them), and the consent it
  carries does not give theirs back.
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
| GET | `/api/subjects/{id}?include_images=false` | Everything stored about one subject ([participants' data](#participants-data)) |
| DELETE | `/api/subjects/{id}/images` | Withdraws consent to store eye images: deletes them and keeps the rest ([participants' data](#participants-data)) |
| DELETE | `/api/subjects/{id}` | Cascading delete, including the stored images. An earlier visit's record cannot bring them back ([participants' data](#participants-data)) |
| POST | `/api/subjects/{id}/ground-truth` | `{eye, method, sphere, cylinder, axis, vertex_distance_mm, instrument, examiner, raw, session_id}`. Stored in minus cylinder. `session_id` is the visit it was measured at (404 if the subject has no such session); give it whenever the subject may have more than one visit |
| POST | `/api/sessions` | `{subject_id, device_id, protocol_version, cycloplegia, condition_label, simulated, ...}` |
| POST | `/api/sessions/{id}/captures` | multipart: `metadata`, `features`, `quality`, optional `image` (PNG). The image is refused with 403 without image consent, or when the subject withdrew it after the session began. It is stored once per capture, and is encrypted at rest when `EYEREF_STORAGE_KEY` is set |
| POST | `/api/sessions/{id}/predictions` | `AssessmentReport`. Stores one row per eye with model, extractor and calibration versions |
| GET | `/api/dataset/export?fmt=csv\|json&include_simulated=false&level=capture\|eye` | `level=capture` (the default): one row per capture, with flattened features, its geometry, quality and extractor version, the visit's start, and the reference refractions of the same visit per method ([pairing](DATASET.md#schema-backendeyerefdbmodelspy)), for [training](MODEL_TRAINING.md#training-on-real-data). `level=eye`: one row per eye per visit, with what the product released, how sure it was, how its frames were graded and the same references, for [validation](VALIDATION_PROTOCOL.md#analysing-a-study) ([columns](DATASET.md)) |

## Participants' data

What a participant can ask of the study, and how the server does it. Each is an admin action, and
each is [audited](#audit-log). See also [Consent and retention](DATASET.md#consent-and-retention).

**A copy of their data.** `GET /api/subjects/{id}` returns everything stored about the subject:

```
{subject: {...},
 visits: [{id, device_id, started_at, ..., references: [...], captures: [...], results: [...]}],
 references_without_visit: [...]}
```

- Each capture has its metadata, features and quality, and `image_stored`. The storage key is left out.
- With `include_images=true`, each capture whose image is stored also has `image`, the eye crop as a
  PNG data URL, decrypted. An image that cannot be read has `image: null`, and `image_unreadable` says
  why: its file is gone because it is being deleted, or it was encrypted with a key the server is not
  given (see [Environment](#environment)).
- Times are in UTC. Visits are oldest first. 404 for an unknown subject.

**Withdrawing image consent.** `DELETE /api/subjects/{id}/images` deletes every eye image stored for
the subject and keeps the rest of their data, which their research consent still covers. It returns
`{subject_id, images_deleted, images_withdrawn_at}`. Calling it again deletes nothing more.

- `consent_image_storage` becomes false, and `images_withdrawn_at` records when.
- No image from a visit that began before then is stored again, whether it comes in an upload or is
  added to the session later. Such a record can still be uploaded without its images.
- The participant can consent again at a later visit. That covers the images of visits after the
  withdrawal only.
- An upload storing images of the subject at the same moment finishes first, and its images are
  deleted too; one that arrives during the withdrawal waits for it, then is refused.

**Leaving the study.** `DELETE /api/subjects/{id}` deletes the subject and everything about them. The
server keeps only a SHA-256 hash of their study code and when they left, never the code. A record of a
visit from before then, sent again or sent late by a phone that was offline, gets 403 and stores
nothing. A visit after it is a new enrolment.

**Retention.** With `EYEREF_IMAGE_RETENTION_DAYS=<days>`, each eye image is deleted that many days
after the server stored it, and the rest of the record stays. The server deletes the images past the
limit when it starts, before it serves anything, and then every hour.

- A value that is not a whole number of days, 1 or more, stops the server at startup.
- Images stored before the server recorded when, by earlier versions, count from when they were
  photographed.
- Unset, images are kept until the participant withdraws image consent or is deleted.

**If deleting fails.** The image files are deleted before the database forgets them. If one cannot be
deleted, the request fails with 500, the images stay recorded, and calling it again finishes the job.
A failed retention pass is logged and tried again an hour later. An image is never left on disk
without a record of it, and the image check finds any file that is
([Looking after stored images](#looking-after-stored-images)).

## Audit log

Every change to research data, and every read or export of it, adds an event to the audit log in the
same transaction as the action, so the two are saved together or not at all. An export is sent only
after its event is saved. A refused request (no consent, a duplicate code, an unknown id) changes
nothing and records nothing.

| Action | Recorded when | Details |
| --- | --- | --- |
| `subject.create` | A subject is enrolled | Research and image consent, consent version |
| `subject.list` | The subject list is read | Number of subjects |
| `subject.read` | A subject's whole record is read | Number of visits, number of images included |
| `subject.images_withdraw` | A subject withdraws consent to store eye images | Number of images deleted |
| `subject.images_expire` | Images pass the [retention limit](#participants-data) | Number of images deleted, the limit in days |
| `subject.images_encrypt` | A subject's images are [encrypted](#looking-after-stored-images), or encrypted again under a new key | Number of images encrypted, number encrypted again |
| `subject.delete` | A subject and all their data are deleted | Number of images deleted |
| `ground_truth.add` | A reference refraction is added | Its id, the visit, the eye, the method |
| `session.create` | A capture session starts | Its id, the device profile, whether it is simulated |
| `capture.add` | A capture is stored | Its id, the session, the eye, whether an image was stored |
| `prediction.add` | A report's results are stored | The session, the new prediction ids |
| `assessment.upload` | A whole record is uploaded | The session; how many reference refractions, captures and images; the prediction ids |
| `subject.consent` | A returning subject gives image consent | The consent version |
| `dataset.export` | The dataset is exported | Format, level, rows, subjects, whether simulated data was included |
| `device.save` | A device profile is added or replaced | Its id and calibration version |

- **Who.** `actor` is the fingerprint of the API token that was used: `tok_` and the first 12 hex
  digits of the token's SHA-256. The token itself is never stored. With auth off, `actor` is
  `anonymous`. For images deleted by the retention limit it is `retention`, and for images encrypted
  from the command line it is `maintenance`. To find which token a fingerprint belongs to:
  `python -c "import hashlib, sys; print('tok_' + hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])" "$TOKEN"`.
- **No personal data.** Events hold ids, counts and flags: no subject codes, measurements, notes or
  images. The trail is therefore kept when a subject is deleted, and still shows what happened to them.
- **Reading it.** `GET /api/audit?subject_id=&action=&before=&limit=` returns `{events, next_before}`,
  newest first. Each event is `{id, at, actor, action, subject_id, details}`, with `at` in UTC.
  `limit` is 1 to 1000 (default 100). To get the next page, pass `next_before` as `before`; it is
  `null` on the last page. It needs an admin token.
- A request with a missing or wrong token gets 401, and one its token's role does not allow gets 403,
  before it reaches the API, so it appears in the server's access log rather than the audit log.

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

## Looking after stored images

Each stored eye image is a file under `$EYEREF_DATA_DIR/objects`, and the database records which file
belongs to which capture. Two commands look after them. Run them beside the server, with its
`EYEREF_DATABASE_URL`, `EYEREF_DATA_DIR` and `EYEREF_STORAGE_KEY`, from `backend/` or in its container:

```bash
docker compose exec api python -m eyeref.api.images check
```

They work only on a database the server has already set up, at the same schema version, and on an
image store that exists. Pointed anywhere else, they stop with exit status 2 and change nothing, so a
wrong setting cannot make every image look like a file no record names.

**Checking.** `python -m eyeref.api.images check` reads every recorded image and lists every file. It
reports:

- an image whose file is gone;
- an image that cannot be read, and why: it was encrypted with a key that `EYEREF_STORAGE_KEY` does not
  list, or the file is not a PNG image, so it is damaged;
- an image stored without encryption although a key is set;
- a file no record names, once it is an hour old. A younger one may belong to an upload still under
  way. Such files are left by a server that stopped between writing an image and recording it, or by
  an encryption that could not delete an old copy.

It also says how many images are encrypted with a key other than the first. That is not a problem, but
the other key is still needed. It exits with status 1 when there is a problem, so a scheduled job can
raise an alert. `--delete-orphans` deletes the files no record names. A check that runs while the
server is deleting images, for a withdrawal or the retention limit, can report one of them as gone; run
it again.

**Encrypting older images.** Images stored while `EYEREF_STORAGE_KEY` was unset stay unencrypted when a
key is set later, and the server logs how many there are when it starts.
`python -m eyeref.api.images encrypt` encrypts them with the first key.

**Rotating the key.**

1. Generate a new key and put it first, keeping the old one after it: `EYEREF_STORAGE_KEY=<new>,<old>`.
   Restart the server. New images use the new key, and the old ones stay readable.
2. Run `python -m eyeref.api.images encrypt` with the same setting. It encrypts every image under the
   old key again, with the new one.
3. When `check` no longer reports images under another key, set `EYEREF_STORAGE_KEY=<new>` and restart.
4. Keep the old key for as long as you keep backups made before step 2. They cannot be read without it.

`encrypt` goes one participant at a time and holds each, as an upload or a withdrawal does, so the
server can keep running. Each image is written under a new name, the database moves to it, and only
then is the old file deleted. If it stops part way, every image is still readable, and running it again
carries on; once nothing is left to do, running it changes nothing. Each participant whose images it
encrypts is [audited](#audit-log) as `subject.images_encrypt` by `maintenance`. It exits with status 1
and lists any image it could not encrypt (the file is gone or cannot be read), and any old file it could
not delete, which `check --delete-orphans` deletes later.

**Backups.** Copy the database first, then the image store:

```bash
# SQLite: a consistent copy while the server runs
python -c "import sqlite3; sqlite3.connect('data/eyeref.db').backup(sqlite3.connect('backup/eyeref.db'))"
# PostgreSQL
pg_dump --format=custom --file=backup/eyeref.dump "postgresql://user:password@host:5432/eyeref"
# then the images, keeping their file times
rsync -a data/objects/ backup/objects/
```

In that order, every image the database copy records was already written, so the copy of the store has
it, unless the image was deleted in between for a withdrawal or the retention limit. Files written after
the database copy are files no record names.

- The database holds study codes, measurements and reference refractions. EyeRef does not encrypt it, so
  encrypt its backups.
- Images are encrypted with the storage key when one is set. Keep the keys apart from the backups: a key
  stored with the images protects nothing.
- A backup keeps what was deleted after it was made. Restoring one brings back images and participants
  withdrawn or deleted since, so keep backups no longer than the study's protocol allows. After a
  restore, repeat the withdrawals and deletions made since the backup: export the audit log first if
  the database is still there, since its `subject.images_withdraw` and `subject.delete` events list
  them. The retention limit applies again on its own when the server starts.

**Restoring.** Stop the server, put back the database and the image store, and start it. It upgrades a
backup made by an older version. Then run `check`, and `check --delete-orphans` to delete the files the
restored database does not name.

## Environment

See `.env.example`. The variables are:

- `EYEREF_DATA_DIR`
- `EYEREF_DATABASE_URL`
- `EYEREF_STORAGE_KEY` (a Fernet key, or several, comma-separated, newest first). New images are
  encrypted with the first, and images stored under any listed key stay readable, as do images stored
  before a key was set. To encrypt those, or to retire an old key, see
  [Looking after stored images](#looking-after-stored-images).
- `EYEREF_MODEL_PATH`
- `EYEREF_CORS_ORIGINS`
- `EYEREF_ENV` (`development` or `production`)
- `EYEREF_API_TOKENS` (comma-separated bearer tokens, each optionally `collect:`, `analyse:` or `admin:` first)
- `EYEREF_MAX_BODY_BYTES` (default 10 MB)
- `EYEREF_IMAGE_RETENTION_DAYS` (delete each eye image this many days after it was stored; unset keeps them)
- `MAIRA_*`
