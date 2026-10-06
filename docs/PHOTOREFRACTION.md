# Eccentric photorefraction: the optics EyeRef relies on

## 1. Principle

A point light source sits a small distance **e** (the eccentricity) from the camera's entrance pupil.
Light enters the subject's eye, forms a blur patch on the retina and is reflected back out. If the eye
is focused exactly at the camera plane, the returning light converges back onto the source. It then
misses the camera aperture uniformly, and the pupil appears evenly lit or dark. If the eye is defocused
relative to the camera, part of the returning beam enters the camera. The pupil then shows a bright
**crescent** on one side.

The model is the knife-edge model of Bobier & Braddick (1985), also used by Howland, Schaeffel and
others. With the subject at distance **d** (m), a pupil of diameter **p** (m) and refraction **R** (D):

- Defocus relative to the camera: **D = R + 1/d**. An emmetrope (R = 0) at 1 m is 1 D "hyperopic"
  relative to the camera.
- Crescent width: **s = p − e / (d·|D|)**. A crescent exists only when s > 0.
- **Dead zone**: no crescent forms when |D| < e/(d·p). In refraction units this is
  **R ∈ [−1/d − e/(d·p), −1/d + e/(d·p)]**.
- Crescent side: for myopic defocus (D < 0) the crescent lies on the **same** side of the pupil as the
  light source, and for hyperopic defocus on the opposite side. This sign depends on the exact optical
  arrangement. It is a single configurable flag (`CRESCENT_SAME_SIDE_FOR_MYOPIC`) that **must be
  verified on the bench** with a model eye and a known lens before any real-eye data are trusted.

Inversion: **|D| = e / (d·(p − s))**, and the sign comes from the crescent side. Uncertainty is
propagated with the delta method over s, p, d and e (`invert_with_uncertainty`). When the crescent
fills more than 92% of the pupil, the measurement is saturated. The magnitude is then only a lower
bound, and σ is floored at 2 D.

## 2. The dead zone is the central limitation

The upper edge of the dead zone is **(e/p − 1)/d**. A phone flash usually sits 8–10 mm from the lens,
and a dark-adapted adult pupil is about 6 mm. That makes **e > p**, so **emmetropia always lies inside
the dead zone, at any distance.**

| Distance | Dead zone (e = 8 mm, p = 6 mm) | Smallest detectable myopia | Smallest detectable hyperopia |
| --- | --- | --- | --- |
| 0.5 m | −4.67 … +0.67 D | −4.7 D | +0.7 D |
| 1.0 m | −2.33 … +0.33 D | −2.3 D | +0.3 D |
| 1.5 m | −1.56 … +0.22 D | −1.6 D | +0.2 D |
| 2.0 m | −1.17 … +0.17 D | −1.2 D | +0.2 D |
| 3.0 m | −0.78 … +0.11 D | −0.8 D | +0.1 D |

Consequences that are built into the software:

1. A frame without a crescent is not "normal". It is an **interval observation**. The fusion step treats
   it as an inequality constraint, never as a point estimate at the interval centre. When every meridian
   is an interval, class probabilities come from a population prior truncated to the interval. The
   output is then "screening only", with the interval stated.
2. **Smaller pupils make the dead zone wider.** Dim the room and wait about 60 s. Pupils under 4 mm
   trigger an advisory, and under about 3 mm the frame is rejected.
3. **Greater distance narrows the dead zone but costs pixels.** At 1 m through a 1080p browser stream,
   a 6 mm pupil spans only about 9–17 px. That is enough to see a crescent, but not to measure its width
   to ±0.25 D. The native app (FUTURE WORK) should use full-resolution stills and optical zoom.
4. **A smaller eccentricity** (an external LED 3–4 mm from the lens, so that e < p) moves emmetropia
   out of the dead zone. This is the development rig profile `external-led-rig`.
5. Inside the dead zone, the **brightness gradient** across the pupil still varies with defocus.
   PowerRefractor-style instruments exploit this. EyeRef converts the gradient into a value only for a
   device with a **bench-calibrated gain** (expressed in dead-zone half-widths per unit normalised
   slope). Without calibration the frame remains an interval.

## 3. Meridians and astigmatism

The crescent measures defocus along the meridian joining the source to the camera. Rotating the device
about the optical axis rotates that meridian. EyeRef captures four device rotations (0°, 45°, 90°,
135°) and computes, for every frame:

```
meridian_eye = (source_angle_in_image − head_roll) mod 180     (TABO convention)
```

The source angle in the image is the flash's direction from the lens plus the **frame's** rotation, not
the phone's tilt. A browser turns a phone camera's frames with the screen, in steps of 90°: at 45° the
screen usually stays in portrait, so the frame is not turned and the head leans 45° the other way in the
picture. The phone's turn from the head is therefore read from the picture, as the frame's rotation
less the eyes' tilt, and the capture screen guides each step with that. Adding a tilt sensor's angle
as well would count the turn twice, and a tilt taken modulo 180° would put the light on the wrong side
of a phone turned clockwise onto its side.

Per-meridian powers are fitted with
**P(θ) = M + J0·cos 2θ + J45·sin 2θ** (Thibos power vectors). This uses weighted least squares with
a weak prior of N(0, diag(4², 0.35², 0.35²)) D². The posterior is sampled to give SPH/CYL/AXIS
distributions. The axis comes from the doubled angle, so 179° and 1° are 2° apart. The axis is never
regressed as a scalar.

With one meridian, astigmatism is not assessed. With two, only a probability of
|CYL| ≥ 0.75 D is reported. CYL/AXIS is shown only when **all** of these hold:

- the research flag is on,
- there are at least 3 distinct quantitative meridians,
- the CYL 95% interval width is ≤ 1.0 D,
- the axis SD is ≤ 15°.

## 4. Image geometry conventions

- All analysis uses the **raw** camera frame. The front-camera preview is mirrored only in CSS.
- In a raw frame of a person facing the camera, the subject's **right eye (OD)** appears on the
  **image left**.
- Image angles are measured counter-clockwise with y up: `image_vector_to_tabo(dx, dy_down) = atan2(−dy, dx)`.
- Un-mirroring maps θ → 180° − θ, and head roll changes sign.
- The flash offset is given in mm in the captured-image frame (x right, y up). The source angle in the
  image is the direction from the lens to the flash, plus the frame's rotation. For the rear camera
  that is the screen's turn from its natural orientation; the front camera looks back at the person
  holding the phone, so for it the screen's turn runs the other way in the image.

## 5. Accommodation

The subject fixates the light at the camera, so accommodation pulls the eye's focus towards the camera
plane. Myopes cannot relax beyond their far point and are measured well. Hyperopes and young people
partly focus their error away. This is **latent hyperopia**, and the simulator reproduces it. EyeRef
therefore:

- adds an age-dependent accommodation SD to M. The SD in dioptres is:
  - age 3–7: 0.80
  - age 8–12: 0.65
  - teen: 0.50
  - adult 18–39: 0.35
  - adult 40–59: 0.20
  - adult 60+: 0.10
- marks every child result as screening only in the UI,
- tells investigators that only **cycloplegic** refraction is a valid ground truth for under-18s.

## 6. Other sources of error

- **Fundus pigmentation and iris colour** change reflex brightness. They affect the gradient method,
  but they have little effect on crescent geometry.
- **Corneal glint** overlapping the crescent edge. The glint is masked and its location used for gaze checks.
- **Off-axis gaze** shifts and distorts the reflex. Frames with a gaze offset above threshold are rejected.
- **Spectacles and contact lenses** add their own power. Glasses must be removed.
- **Media opacities** (cataract) and **strabismus** can make the reflexes asymmetric. The OD/OS
  brightness ratio is flagged at 1.35 or above, and that is a referral reason, not a refraction.

## References

- Bobier WR, Braddick OJ. Eccentric photorefraction: optical analysis and empirical measures. *Am J Optom Physiol Opt* 1985.
- Howland HC. Optics of photoretinoscopy: results from ray tracing. *Am J Optom Physiol Opt* 1985.
- Schaeffel F, Farkas L, Howland HC. Infrared photoretinoscope. *Appl Opt* 1987.
- Roorda A, Campbell MCW, Bobier WR. Slope-based eccentric photorefraction. *JOSA A* 1997.
- Thibos LN, Wheeler W, Horner D. Power vectors: an application of Fourier analysis to the description and statistical analysis of refractive error. *Optom Vis Sci* 1997.
