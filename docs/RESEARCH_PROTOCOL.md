# Research protocol: from bench to the first 100 labelled eyes

This is a practical, staged plan. Each stage has a go/no-go criterion. Do not skip stage 0. The optics
sign convention and the device geometry must be right before any person is measured.

## Hardware and phone setup

| Item | Recommendation |
| --- | --- |
| Phone | Android phone with a rear camera and LED torch; **Chrome** (torch control). Note the model. iOS Safari cannot control the torch from the web, so wait for the native app. |
| Mount | Tripod with a phone clamp that rotates about the lens axis, marked at 0°, 45°, 90° and 135°. A 3D-printed rotating clamp with detents is ideal. Nothing attaches to the phone optics. |
| Distance | Tape the floor at **1.0 m** and **1.5 m** from the lens to the subject's corneal plane. Use the "I measured the distance" switch. |
| Room | Dim, below about 10 lux at the eyes, with no light source behind the camera facing the subject. Allow 60 s of dark adaptation. |
| Fixation | The subject looks at the torch LED. For children, use a small sound or toy right next to the lens. |
| Bench | A model eye (a schematic retinoscopy eye with a pupil of at least 5 mm), a trial lens set (±0.25…±6 D, cylinders 0.5–2 D) and a trial frame. |
| Reference | An autorefractor at minimum (3 readings, averaged). Subjective refraction where possible. Cycloplegic refraction for anyone under 18. |
| Measure once | Flash offset with calipers (x, y in mm, portrait, screen facing you). HFOV with the ruler method. Both go in **Calibration → Add a measured device**. |

## Stage 0: bench (1–2 days, no people)

The app runs this stage: **Calibration → Open the bench** (docs/DEVICE_CALIBRATION.md section 3). It
guides each step, checks every criterion below, and saves the gain on go. Keep the run's file with the
study records; `python -m eyeref.research.bench_run` gives the same report from it.

1. Put the model eye on the mount at 1.0 m.
2. Place lenses from −4 to +4 D in 0.5 D steps in front of it. Capture 5 frames at each step at 0°,
   then repeat at 90°.
3. Verify the **crescent side** for a known myopic lens. If it is opposite to the expectation, flip
   `CRESCENT_SAME_SIDE_FOR_MYOPIC` in both implementations and record why.
4. Fit the crescent-width curve and the dead-zone edges against the Bobier–Braddick prediction (the
   research bench functions in `eyeref.research.bench`). The predicted dead zone for your measured e,
   d and p should match within ±0.25 D.
5. Fit the **gradient gain** inside the dead zone (`fit_gradient_gain`). Record the gain, the residual
   SD and a calibration version in a new device profile.

**Go/no-go:**

- the crescent side is correct in 100% of non-dead-zone steps (more than 0.25 D outside the predicted
  dead zone, on both sides of it);
- the width slope matches the model (0.8 to 1.2);
- the measured dead-zone edges are within 0.25 D of prediction;
- ICC(1,1) of repeated frames is at least 0.9;
- the gain fit has r of at least 0.9 in magnitude and a residual SD of at most 0.35 of a half-width;
- every step has a usable frame.

## Stage 1: the first experiment, induced defocus in adults (n ≈ 10 people, 20 eyes)

This is the cleanest first human experiment, because the **change** in refraction is known exactly. The
app runs it: **Validation → Stage 1: induced defocus**. It fixes each participant's lens order from their
code, records the lens with every capture, and checks the criteria below; `make stage1 DATA=…` gives the
same report from the file it saves.

- Participants are adults aged 18–39 (low accommodation variability relative to children). Use their
  habitual correction (contact lenses, or their glasses prescription in a trial frame) to make them
  near-emmetropic. A correction held in the trial frame changes what a lens added in front of it does at
  the eye, so the page asks where the correction sits and takes the vertex distance into account.
- Add lenses of **0, +1.50, +2, +2.50, +3 and +4 D** over the correction, in the order the participant's
  code gives. Capture the standard protocol for each lens.
- **Why only plus lenses.** The subject fixates the light at the camera, 1 m away, so an eye that can
  focus will pull about 1 D of accommodation into every reading, and a minus lens only asks for more. A
  plus lens does the opposite: once the eye is more myopic than the light is near, the light lies beyond
  its far point, focusing can only blur it further, and the eye relaxes. From +1.50 D over the correction
  at 1 m, every eye within ±0.50 D of emmetropia is fogged, so the lens accounts for the whole change.
  The analysis calls those captures *fogging* and fits the slope to them alone; a lens that leaves the
  light within reach is recorded but left out of the slope.
- **The no-lens capture** is the control: with the frame empty the light is within reach, so the
  difference between it and the eye's own fogging line measures how far that eye followed the light. That
  is the focusing every ordinary EyeRef capture allows for, measured here rather than assumed, and it is
  reported next to the slope instead of being folded into it. The app assumes an eye follows anywhere from
  none to all of the way (PHOTOREFRACTION.md § 5); this measurement is what can narrow that, and with it
  the ranges the app gives eyes that can see the light.
- The outcome is the slope and intercept of measured M against induced defocus. The ideal slope is 1.
  One slope is fitted across eyes, each eye with its own intercept, and its 95% interval treats each
  **person** as one unit (a cluster-robust standard error), because two eyes of one person move together.
  Report repeatability as ICC and the within-subject SD; the SD around each eye's line also gives the
  smallest change between two captures of one eye that is not noise (1.96 × √2 × SD).
- Stage 0 comes first: without a bench-measured gain the dead zone returns ranges rather than numbers, so
  a near-emmetropic eye at the no-lens step may have nothing to release.

**Go/no-go:**

- the slope is 0.8–1.2;
- the within-subject SD is at most 0.5 D for released results;
- at least 60% of captures pass quality (the app did not ask for a repeat);
- at least 10 people captured at every lens, before any verdict is read at all.

If this fails, fix capture and optics before collecting a dataset.

**Keeping the data straight.** A stage 1 capture measured the eye *and* a trial lens, so its values are
never the participant's refraction. The app keeps them out of the trend in History, out of the printable
referral report and out of research uploads, because the research server does not record the lens.

## Stage 2: the first 100 labelled eyes (about 50 adults)

**Sample.**

- 50 adults aged 18–60, both eyes, recruited to span **−6 to +3 D SE**.
- Fill these quotas:
  - at least 15 people with myopia at or beyond −1 D;
  - at least 10 people between −1 and +0.5 D;
  - at least 8 hyperopes at or above +1 D;
  - at least 10 people with astigmatism of 1 D or more.

**Exclusions.**

- Strabismus.
- Media opacity.
- Previous refractive surgery. Keep this as a separate stratum later.
- Pupils under 3.5 mm in dim light.

**Visit flow (about 20 min).**

1. Consent, study code, age band and eye colour.
2. Remove glasses or contact lenses. Contact lenses must be out for at least 15 minutes before the
   autorefraction.
3. Dim room, 60 s adaptation.
4. EyeRef capture: 4 meridians × 5 frames at 1.0 m. Then **repeat the whole capture** after the person
   stands up and sits down again. The repeat gives test–retest data.
5. Optionally, one more capture at 1.5 m to study the dead zone against distance.
6. Autorefraction: 3 readings, averaged. Subjective refraction if available.
7. The operator enters the reference refraction in **Dataset**.

Randomise the order of steps 4 and 6 across participants. The operator entering the reference must not
see the EyeRef result.

**Data handling.**

- Upload each record with consent, including images only if separately consented.
- Run `GET /api/dataset/export` weekly.
- Check the agreement panel and the rejection rate. A rejection rate above 40% means the protocol needs
  fixing; do not keep collecting.

**Analysis at n = 100 eyes.** See VALIDATION_PROTOCOL.md, which shows how to run the analysis on the
research server's export. Use one randomly chosen eye per person for the primary analysis (`--one-eye`),
and both eyes as a secondary analysis, with intervals from resampling people so that the two eyes of one
person are not counted as independent.

## Stage 3: children (only after stage 2 is published or at least analysed)

- Ages 3–12. **Cycloplegic** refraction is the reference.
- Get ethics approval for paediatric research, with parental consent and child assent.
- Measure before and after cycloplegia, to quantify the accommodation effect that the app currently
  only models.
