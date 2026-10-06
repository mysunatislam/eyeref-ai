# Dataset

## Principles

- **Pseudonymous.** Subjects are identified only by a random study code, such as `SITE1-0042`. The
  key that links a code to an identity stays on paper or in the site's secure study log, never in
  EyeRef.
- **Consent first.**
  - The API returns 403 for any subject without `consent_research`.
  - Images need a separate `consent_image_storage`, which the participant can withdraw at any time
    while staying in the study.
  - Deleting a subject cascades to its sessions, captures, predictions and ground truth, and deletes
    the encrypted image objects.
  - Eye images can expire after a set number of days. See [Consent and retention](#consent-and-retention).
- **Audited.** Every change to research data, and every read or export of it, is recorded with the
  token that made it. The record holds ids and counts only, so it is kept after a subject is deleted
  (see [API](API.md#audit-log)).
- **No face images.** The app stores only eye crops, about 1.6 × the iris diameter, and only with
  consent.
- **Simulated data is flagged** at the session level, and exports exclude it unless
  `include_simulated=true` is passed.

## Consent and retention

What a participant can ask of the study, and what the research server does. Each is done by the
study's administrator through the API ([Participants' data](API.md#participants-data)), and each is
recorded in the audit log.

| The participant asks | The server |
| --- | --- |
| For a copy of their data | Returns everything stored about them: each visit with its reference refractions, captures and results, and on request their eye images, decrypted |
| To stop storing eye images of them | Deletes every eye image stored for them and keeps the rest, which their research consent still covers. No image from a visit before then is stored again, even from a phone that uploads an older record later |
| To leave the study | Deletes the subject and everything about them, images included. It keeps only a hash of their study code and the date, so a record of an earlier visit still waiting on a phone cannot bring them back |

- **Consent again.** A participant who withdrew image consent can give it again at a later visit. It
  covers that visit and the ones after it, never an earlier one.
- **Retention.** Set `EYEREF_IMAGE_RETENTION_DAYS` to the number of days the study's protocol allows
  eye images to be kept. The server deletes each image that long after it stored it, when it starts
  and every hour, and keeps the rest of the record. Unset, images are kept until the participant
  withdraws or is deleted.
- **Nothing left behind.** The image files are deleted before the database forgets them. If deleting
  fails, the images stay recorded and the next attempt deletes them, so no image stays on disk without
  a record of it. An upload that stores images at the same moment as a withdrawal or deletion either
  finishes first, and loses its images with the rest, or waits and is refused. The image check lists any
  file no record names, such as one left by a server that stopped mid-upload, and can delete it
  ([Looking after stored images](API.md#looking-after-stored-images)).
- **Backups.** A backup keeps what was deleted after it was made, so keep backups no longer than the
  protocol allows, and after restoring one, repeat the withdrawals and deletions made since
  ([Backups](API.md#looking-after-stored-images)).
- **On the phone.** The web app keeps its own copy only on the device, with its own limit of 7, 30 or
  90 days, chosen in History.

## Schema (backend/eyeref/db/models.py)

| Table | Key fields |
| --- | --- |
| `subjects` | `code` (unique, pseudonymous), `age_group`, `consent_research`, `consent_image_storage`, `consent_version`, `images_withdrawn_at`, `wears_correction`, `iris_color`, `site` |
| `devices` | `id`, manufacturer, model, camera, full `DeviceProfile` JSON, `calibration_version` |
| `capture_sessions` | subject, device, `protocol_version`, operator, `ambient_lux`, room condition, **`cycloplegia`**, `condition_label`, `simulated` |
| `captures` | session, eye, frame index, timestamp, `working_distance_m`, illumination, **`meridian_deg`**, metadata JSON, features JSON, quality JSON / score / grade, `pupil_diameter_mm`, encrypted `image_key`, `image_stored_at` (when the server stored the image) |
| `ground_truth` | subject, **visit** (the session it was measured at), eye, **method** (autorefractor, subjective, cycloplegic, retinoscopy, trial_lens, lensmeter), sphere / cylinder / axis (**stored as minus cylinder**), SE, vertex distance, instrument, examiner, raw printout JSON |
| `predictions` | session, eye, output level, SE + CI, sphere, cylinder, axis, M/J0/J45, confidence, class, **model name and version, calibration version, device profile, extractor version**, full report JSON |
| `audit_events` | time, actor (token fingerprint), action, subject id, details (ids, counts and flags only). No foreign keys, so events outlive what they describe |
| `deleted_subjects` | SHA-256 of a deleted subject's code (never the code) and when they were deleted |

JSON Schemas of the exchange models live in `shared/schemas` and are regenerated with `make schemas`.

`GET /api/dataset/export?fmt=csv` produces one row per capture, ordered by visit, eye and frame, so the
same data always exports to the same file. Each row holds the flattened `f_*` features,
`session_started_at`, and the `gt_<method>_{sph,cyl,axis,se,vertex_mm}` columns for that eye. For
training it also has the light source's distance from the lens edge (`eccentricity_mm`: the
capture's own value if it recorded one, otherwise the phone's profile), the pupil diameter, the frame's
hard failures (`hard_failures`, separated by `|`) and the feature extractor version. `make dataset`
turns it into the training table that `ml/` reads ([Model training](MODEL_TRAINING.md#training-on-real-data)).

`level=eye` produces one row per eye per visit instead: the result the product released (outcome, SE
and its interval, power vector, class and astigmatism probabilities, frame counts, model version) next
to the same references. For the protocol's subgroups, each row also has the median pupil diameter
(`pupil_mm`) and working distance (`distance_m`) of that eye's captures, and the subject's sex, iris
colour and pigmentation when they were collected. For the gate analysis it has the M the product
computed even when it held the eye back (`pred_m`) and its SD (`pred_m_sd`), the number of the eye's
frames at each quality grade (`frames_excellent`, `frames_acceptable`, `frames_poor`, `frames_reject`),
and, for the frames not used, how many failed for each reason (`frames_failed_<reason>`, such as
`frames_failed_pupil_too_small`; `low_score` when the overall score alone was too low). A frame can fail
for more than one reason. This is the input to the study analysis in VALIDATION_PROTOCOL.md. An eye photographed
at a visit without a result still gets a row, so every eye that entered the protocol is counted.

A capture is paired only with a reference measured at the same visit, as the validation protocol
requires. If a method was recorded twice for an eye at one visit, the later entry counts. A reference
recorded without a visit is used only while the subject has a single visit; once there are two, it
could belong to either, so it is paired with neither. Uploads from the web app always name the visit.

## Investigator workflow (Mode 2)

1. Consent, then assign a study code. Record the code↔identity link outside EyeRef.
2. Do the camera capture in **Dataset** or **Assess** mode with the standard protocol (4 meridians ×
   5 frames, 1 m, dim room).
3. Take the reference measurement within 30 minutes, in the same room conditions where possible:
   - an autorefractor at minimum;
   - subjective refraction where available;
   - cycloplegic refraction for anyone under 18.
4. In the **Dataset** page, enter the code and the reference refraction. Plus-cylinder printouts are
   converted to minus cylinder automatically.
5. Export pairs as CSV, or upload the record to the research server with consent. Consent is
   confirmed for each record at each visit. The upload stores the whole record or nothing, so a
   failed upload can simply be sent again, and a second visit for the same code becomes another
   session of the same subject.
6. Once a week, check the agreement panel (MAE, bias, limits of agreement) and the rejection rate.

## Labels

- **Primary label:** spherical equivalent from the best available reference. The priority order is
  cycloplegic, then subjective, then autorefractor, then retinoscopy.
- **Training targets:** M, J0 and J45 from the reference, plus the **per-meridian power**
  P(θ) = M + J0·cos 2θ + J45·sin 2θ at each capture's meridian. These are the eye's own refraction.
  The camera saw the eye focused on the light, by an amount no capture shows, so a model trained on
  them learns how far its training eyes focused on average (MODEL_TRAINING.md, What the models learn).
- Axis is recorded but always modelled through J0/J45.

## Optically valid augmentations (ml/eyeref_ml/datasets/augment.py)

These are allowed:

- **Small in-plane rotations** (≤ 6°), with the meridian label rotated by the same angle.
- **Horizontal flip.** This changes the labels as well:
  - axis becomes 180° − axis;
  - J45 becomes −J45;
  - OD becomes OS, and OS becomes OD;
  - the source direction is mirrored.
- **Exposure and gamma** (±15%), **sensor noise** and **mild blur** (σ ≤ 0.8 px).
- **Colour jitter** of the iris and skin. The fundus reflex hue must not be changed, because it carries
  information.

These are **not** allowed:

- scaling the pupil without changing the label (crescent width is relative to the pupil);
- vertical flips, unless the source angle is flipped too;
- mixing frames from different subjects, or any synthetic crescent editing on real images.

## Splits

- Splits are always made **by subject**: no person appears in both train and test, and both eyes and
  all frames of a person stay together. `assert_no_leakage` runs in every training script.
- Cross-device generalisation is tested by **leave-one-device-out**.
- A calibration subset, also subject-disjoint, is used for conformal intervals and early stopping.
