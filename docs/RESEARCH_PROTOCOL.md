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

- the crescent side is correct in 100% of non-dead-zone steps;
- the width slope matches the model;
- the measured dead-zone edges are within 0.25 D of prediction;
- ICC(1,1) of repeated frames is at least 0.9.

## Stage 1: the first experiment, induced defocus in adults (n ≈ 10 people, 20 eyes)

This is the cleanest first human experiment, because the **change** in refraction is known exactly.

- Participants are adults aged 18–39 (low accommodation variability relative to children). Use their
  habitual correction (contact lenses, or their glasses prescription in a trial frame) to make them
  near-emmetropic.
- Add lenses of **−2, −1, 0, +1 and +2 D** over the correction, in random order. A plus lens makes the
  eye relatively myopic. Capture the standard protocol for each lens.
- The outcome is the slope and intercept of measured M against induced defocus. The ideal slope is 1.
  Report repeatability as ICC and the within-subject SD.

**Go/no-go:**

- the slope is 0.8–1.2;
- the within-subject SD is at most 0.5 D for released results;
- at least 60% of captures pass quality.

If this fails, fix capture and optics before collecting a dataset.

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

**Analysis at n = 100 eyes.** See VALIDATION_PROTOCOL.md. Use one randomly chosen eye per person for
the primary analysis, and both eyes in a mixed model as a secondary analysis.

## Stage 3: children (only after stage 2 is published or at least analysed)

- Ages 3–12. **Cycloplegic** refraction is the reference.
- Get ethics approval for paediatric research, with parental consent and child assent.
- Measure before and after cycloplegia, to quantify the accommodation effect that the app currently
  only models.
